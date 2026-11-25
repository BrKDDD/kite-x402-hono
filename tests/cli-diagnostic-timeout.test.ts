import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { harness, PAY_TO } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runDiagnostic(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", cli, ...args, "--json"],
    { cwd: tmpdir(), env: {}, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 7000);
  try {
    const output = await new Response(child.stdout).text();
    return { exit: await child.exited, report: JSON.parse(output) };
  } finally {
    clearTimeout(timer);
  }
}

function argsFor(mode: string, origin: string) {
  return mode === "--probe-service"
    ? [mode, origin, "--network", "testnet"]
    : [
        mode,
        `${origin}/v1/echo`,
        "--network",
        "testnet",
        "--amount",
        "1000000000000000",
        "--pay-to",
        PAY_TO,
      ];
}

test.each(["--probe-service", "--check-challenge"])(
  "%s applies the caller's deadline to an unpaid local diagnostic",
  async (mode) => {
    const { app, events } = harness();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/readyz" || path === "/v1/echo") await Bun.sleep(300);
        return app.fetch(request);
      },
    });
    try {
      const args = argsFor(mode, server.url.origin);
      const short = await runDiagnostic([...args, "--timeout-ms", "25"]);
      expect(short.exit).toBe(1);
      expect(short.report.ok).toBe(false);
      if (mode === "--probe-service") {
        expect(short.report.checks).toContainEqual({
          path: "/readyz",
          ok: false,
          code: "timeout",
        });
      } else {
        expect(short.report.code).toBe("timeout");
      }
      const longer = await runDiagnostic([...args, "--timeout-ms=2000"]);
      expect(longer.exit).toBe(0);
      expect(longer.report.ok).toBe(true);
      expect(events).toEqual([]);
    } finally {
      await server.stop(true);
    }
  },
);

test("CLI reports invalid, missing and repeated deadlines and rejects the flag in offline mode", async () => {
  const args = argsFor("--check-challenge", "http://127.0.0.1:1");
  const invalid = "--timeout-ms must be an integer in 1–300000 milliseconds.";
  for (const flags of [
    ["--timeout-ms"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "1.5"],
    ["--timeout-ms", "300001"],
    ["--timeout-ms="],
  ]) {
    expect(await runDiagnostic([...args, ...flags])).toEqual({
      exit: 1,
      report: { ok: false, error: invalid },
    });
  }
  expect(
    await runDiagnostic([...args, "--timeout-ms=50", "--timeout-ms", "60"]),
  ).toEqual({
    exit: 1,
    report: { ok: false, error: "Supply --timeout-ms only once." },
  });
  expect(await runDiagnostic(["--check-config", "--timeout-ms", "50"])).toEqual(
    {
      exit: 1,
      report: {
        ok: false,
        error: "--timeout-ms requires --probe-service or --check-challenge.",
      },
    },
  );
});
