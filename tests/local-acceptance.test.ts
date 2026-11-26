import { expect, test, spyOn } from "bun:test";
import { fileURLToPath } from "node:url";
import { runLocalAcceptance } from "../src/local-acceptance.js";

test("local acceptance covers successful diagnostics and deliberate policy failures", async () => {
  const report = await runLocalAcceptance();
  expect(report.ok).toBe(true);
  expect(report.scope).toBe("local-simulation-only");
  expect(report.checks.map((c) => c.name)).toEqual([
    "valid_configuration",
    "invalid_configuration_rejected",
    "service:/healthz",
    "service:/readyz",
    "service:/.well-known/x402",
    "wrong_network_rejected",
    "unpaid_challenge_matches",
    "wrong_amount_rejected",
    "wrong_recipient_rejected",
    "no_payment_operations",
  ]);
  expect(report.checks.every((c) => c.ok)).toBe(true);
  expect(report.paymentCalls).toEqual({ verify: 0, upstream: 0, settle: 0 });
});
test("independent runs can execute concurrently on ephemeral ports", async () => {
  const results = await Promise.all([
    runLocalAcceptance(),
    runLocalAcceptance(),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results[0]).toEqual(results[1]);
});
test("standalone runner ignores merchant environment and exits after cleanup", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/local-acceptance.ts", import.meta.url)),
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        PAY_TO: "SECRET_INVALID",
        KITE_NETWORK: "invalid",
        UPSTREAM_URL: "https://must-not-contact.invalid",
        FACILITATOR_URL: "https://must-not-contact.invalid",
        MAINTENANCE_MODE: "true",
      },
    },
  );
  const timer = setTimeout(() => proc.kill(), 10000);
  try {
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(output).ok).toBe(true);
    expect(output).not.toContain("SECRET_INVALID");
    expect(await new Response(proc.stderr).text()).toBe("");
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
});
test("unknown runner options fail instead of silently ignoring operator input", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/local-acceptance.ts", import.meta.url)),
      "--target",
      "https://remote.invalid",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("Usage:");
});

test("execution failure produces a failed redacted report", async () => {
  const serve = spyOn(Bun, "serve").mockImplementation(() => {
    throw new Error("SECRET bind failure");
  });
  try {
    const report = await runLocalAcceptance();
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: "acceptance_execution",
      ok: false,
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  } finally {
    serve.mockRestore();
  }
});
