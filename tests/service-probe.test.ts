import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { probeService, formatServiceProbe } from "../src/index.js";
import { harness } from "./helpers.js";
const options = {
  origin: "https://gateway.example",
  expectedNetwork: "testnet",
};

function serve(app: ReturnType<typeof harness>["app"]) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
}

test("real HTTP gateway diagnostics only visit three public endpoints", async () => {
  const { app, events } = harness();
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      paths.push(new URL(req.url).pathname);
      return app.fetch(req);
    },
  });
  try {
    const result = await probeService({
      origin: server.url.origin,
      expectedNetwork: "2368",
    });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.code)).toEqual(["ok", "ok", "ok"]);
    expect(paths.sort()).toEqual(["/.well-known/x402", "/healthz", "/readyz"]);
    expect(events).toEqual([]);
    expect(formatServiceProbe(result)).toContain("do not prove");
  } finally {
    server.stop(true);
  }
});

test.each([
  "maintenance_mode",
  "facilitator_unavailable",
  "network_not_offered",
])("distinguishes readyz %s while health remains up", async (reason) => {
  const { app } = harness({
    env: reason === "maintenance_mode" ? { MAINTENANCE_MODE: "true" } : {},
    facilitator:
      reason === "facilitator_unavailable"
        ? {
            getSupported: async () => {
              throw new Error("secret-internal");
            },
          }
        : reason === "network_not_offered"
          ? {
              getSupported: async () => ({
                kinds: [],
                extensions: [],
                signers: {},
              }),
            }
          : {},
  });
  const server = serve(app);
  try {
    const result = await probeService({
      origin: server.url.origin,
      expectedNetwork: "testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.code).toBe("ok");
    expect(result.checks[1]?.code).toBe(reason);
    expect(JSON.stringify(result)).not.toContain("secret-internal");
  } finally {
    server.stop(true);
  }
});

test("expected network mismatch cannot report success", async () => {
  const { app } = harness();
  const server = serve(app);
  try {
    const result = await probeService({
      origin: server.url.origin,
      expectedNetwork: "mainnet",
    });
    expect(result.checks.every((c) => c.code === "network_mismatch")).toBe(
      true,
    );
  } finally {
    server.stop(true);
  }
});

test.each([
  "https://user:password@example.com",
  "http://remote.example",
  "https://example.com/path",
  "https://example.com?token=secret",
  "file:///tmp/file",
])("invalid target is rejected before fetch: %s", async (origin) => {
  let calls = 0;
  await expect(
    probeService({ ...options, origin }, async () => {
      calls++;
      return new Response();
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test.each(["asset", "protocol", "amount"])(
  "discovery %s mismatch fails despite HTTP 200",
  async (field) => {
    const { app } = harness();
    const result = await probeService(options, async (url) => {
      const path = new URL(url).pathname;
      const res = await app.request(path);
      if (path !== "/.well-known/x402") return res;
      const data = await res.json();
      if (field === "asset")
        data.asset.address = "0x0000000000000000000000000000000000000001";
      if (field === "protocol") data.x402Version = 1;
      if (field === "amount") data.pricing.atomicAmount = "1e3";
      return Response.json(data);
    });
    expect(result.ok).toBe(false);
    expect(result.checks[2]?.code).toBe(
      field === "asset"
        ? "asset_mismatch"
        : field === "protocol"
          ? "protocol_mismatch"
          : "invalid_response",
    );
  },
);

test("redirects are not followed, credentials are not attached and remote data is omitted", async () => {
  const result = await probeService(options, async (_url, init) => {
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    return new Response("remote-secret", {
      status: 302,
      headers: { Location: "https://secret.example" },
    });
  });
  expect(result.checks.every((c) => c.code === "redirect")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("unreachable, invalid JSON, oversized and stalled bodies produce bounded errors", async () => {
  const failure = await probeService(options, async () => {
    throw new Error("private hostname");
  });
  expect(failure.checks.every((c) => c.code === "unreachable")).toBe(true);
  expect(JSON.stringify(failure)).not.toContain("private");
  for (const body of ["<html>private</html>", "[]", "x".repeat(65537)]) {
    const report = await probeService(options, async () => new Response(body));
    expect(report.checks.every((c) => c.code === "invalid_response")).toBe(
      true,
    );
  }
  const stalled = await probeService(
    { ...options, timeoutMs: 30 },
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
  );
  expect(stalled.checks.every((c) => c.code === "timeout")).toBe(true);
});

test("real HTTP headers deadline is bounded", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await Bun.sleep(100);
      return Response.json({});
    },
  });
  try {
    const report = await probeService({
      origin: server.url.origin,
      expectedNetwork: "testnet",
      timeoutMs: 15,
    });
    expect(report.checks.every((c) => c.code === "timeout")).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("CLI probes without PAY_TO or UPSTREAM_URL and returns JSON with correct exit status", async () => {
  const { app } = harness();
  const server = serve(app);
  try {
    for (const [network, expected] of [
      ["testnet", 0],
      ["mainnet", 1],
    ] as const) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "--probe-service",
          server.url.origin,
          "--network",
          network,
          "--json",
        ],
        { cwd: tmpdir(), env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill(), 7000);
      try {
        const report = JSON.parse(await new Response(child.stdout).text());
        expect(await child.exited).toBe(expected);
        expect(report.ok).toBe(expected === 0);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    }
  } finally {
    server.stop(true);
  }
});

test("HTTP errors cannot be mistaken for a healthy endpoint", async () => {
  const report = await probeService(
    options,
    async () => new Response("private diagnostic", { status: 404 }),
  );
  expect(
    report.checks.every((c) => c.code === "http_error" && c.status === 404),
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain("private diagnostic");
});

test("invalid network and deadlines fail before network IO", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return new Response();
  };
  await expect(
    probeService({ ...options, expectedNetwork: "base" }, fake),
  ).rejects.toThrow();
  for (const timeoutMs of [0, -1, NaN, 1.5, 300001])
    await expect(
      probeService({ ...options, timeoutMs }, fake),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});
