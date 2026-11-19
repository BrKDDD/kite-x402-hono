import { expect, test } from "bun:test";
import {
  checkConfig,
  formatConfigPreflight,
  loadConfig,
} from "../src/index.js";
const valid = {
  PAY_TO: "0x1234567890123456789012345678901234567890",
  UPSTREAM_URL: "http://localhost:8081",
  KITE_NETWORK: "testnet",
};

test("preflight aggregates errors without echoing input or credentials", () => {
  const input = {
    ...valid,
    PAY_TO: "secret-wallet",
    UPSTREAM_URL: "https://user:secret-pass@example.com",
    PORT: "70000",
    FIREWALL_ALLOWLIST: "secret-rule",
    UPSTREAM_AUTH_VALUE: "secret-token\r\nx",
  };
  const before = { ...input };
  const report = checkConfig(input);
  expect(report.ok).toBe(false);
  expect(report.errors.map((e) => e.field)).toEqual(
    expect.arrayContaining([
      "PAY_TO",
      "UPSTREAM_URL",
      "PORT",
      "FIREWALL_ALLOWLIST",
      "UPSTREAM_AUTH_VALUE",
    ]),
  );
  expect(JSON.stringify(report)).not.toContain("secret-");
  expect(formatConfigPreflight(report)).not.toContain("secret-");
  expect(input).toEqual(before);
  expect(report.summary).toBeUndefined();
});
test("missing required fields are reported together", () => {
  expect(checkConfig({}).errors.map((e) => e.field)).toEqual([
    "PAY_TO",
    "UPSTREAM_URL",
  ]);
});
test("preflight matches startup validation for representative field boundaries", () => {
  const cases = [
    { KITE_NETWORK: "base" },
    { PRICE_USD: "0" },
    { PRICE_USD: "0.0000001" },
    { PRICE_USD: "$0.001" },
    { KITE_NETWORK: "eip155:2366" },
    { PORT: "65535" },
    { MAX_BODY_BYTES: "16777217" },
    { FACILITATOR_URL: "http://remote.example/v2" },
    { CORS_ORIGIN: "*" },
    { CORS_ORIGIN: "https://example.com/path" },
    { UPSTREAM_AUTH_HEADER: "payment-signature" },
    { RATE_LIMIT_RPS: "0" },
    { TRUSTED_PROXY_CIDRS: "::1/129" },
    { FIREWALL_BLOCKLIST: "192.0.2.0/24" },
  ];
  for (const extra of cases) {
    const env = { ...valid, ...extra };
    let accepted = true;
    try {
      loadConfig(env);
    } catch {
      accepted = false;
    }
    expect(checkConfig(env).ok).toBe(accepted);
  }
});
test("summary preserves exact Kite amounts and excludes endpoint and auth secrets", () => {
  const report = checkConfig({
    ...valid,
    UPSTREAM_AUTH_VALUE: "private-token",
    UPSTREAM_URL: "https://private-host.example",
    PRICE_USD: "0.001",
  });
  expect(report.summary).toEqual({
    network: "eip155:2368",
    asset: "pieUSD",
    priceAtomic: "1000000000000000",
  });
  expect(JSON.stringify(report)).not.toContain("private-");
  expect(report.warnings).toEqual([]);
});
test("operational warnings do not turn valid configuration into an error", () => {
  const report = checkConfig({
    ...valid,
    KITE_NETWORK: "",
    TRUST_PROXY_HEADERS: "true",
    RATE_LIMIT_BURST: "20",
    MAINTENANCE_MODE: "true",
  });
  expect(report.ok).toBe(true);
  expect(report.warnings.map((w) => w.field)).toEqual([
    "KITE_NETWORK",
    "TRUST_PROXY_HEADERS",
    "RATE_LIMIT_BURST",
    "MAINTENANCE_MODE",
  ]);
});

test("CLI exits without opening a port or contacting the facilitator", async () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  // Keeping the requested port occupied proves preflight never starts Bun.serve.
  const server = Bun.serve({ port: 0, fetch: () => new Response("occupied") });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn(
      [process.execPath, "--no-env-file", cli, "--check-config", "--json"],
      {
        cwd: "/tmp",
        env: {
          ...valid,
          PORT: String(server.port),
          FACILITATOR_URL: "http://127.0.0.1:1/v2",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child?.kill(), 5000);
    try {
      const output = await new Response(child.stdout as ReadableStream).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output).scope).toBe("configuration-only");
      expect(JSON.parse(output).ok).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    child?.kill();
    server.stop(true);
  }
});
test("CLI invalid configuration returns JSON and exit code 1", async () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", cli, "--check-config", "--json"],
    {
      cwd: "/tmp",
      env: { PAY_TO: "invalid", UPSTREAM_URL: "invalid" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const output = await new Response(child.stdout as ReadableStream).text();
    expect(await child.exited).toBe(1);
    expect(JSON.parse(output).errors).toHaveLength(2);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
