import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let fixture: string;
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "kite-cli-mode-"));
  for (const file of [
    "cli.ts",
    "config.ts",
    "config-preflight.ts",
    "networks.ts",
    "firewall.ts",
    "service-probe.ts",
    "payment-challenge.ts",
  ]) {
    copyFileSync(
      fileURLToPath(new URL(`../src/${file}`, import.meta.url)),
      join(fixture, file),
    );
  }
  // 保留真实诊断模块；只有服务器入口会在误加载时立即失败。
  writeFileSync(
    join(fixture, "app.ts"),
    'throw new Error("server module must remain unloaded"); export const createApp = () => {};',
  );
});
afterAll(() => {
  const target = resolve(fixture);
  if (!target.startsWith(resolve(tmpdir()) + sep))
    throw new Error("Unexpected fixture path");
  rmSync(target, { recursive: true, force: true });
});

async function run(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(fixture, "cli.ts"), ...args],
    {
      cwd: fixture,
      env: {
        PAY_TO: "0x1234567890123456789012345678901234567890",
        UPSTREAM_URL: "http://localhost:8081",
        KITE_NETWORK: "testnet",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 4000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

test("help does not load the server module", async () => {
  const result = await run(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: kite-x402-hono");
  expect(result.stderr).toBe("");
});
test("offline preflight does not load the server module", async () => {
  const result = await run(["--check-config", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    scope: "configuration-only",
  });
  expect(result.stderr).toBe("");
});
test("invalid output mode is rejected without loading the server", async () => {
  const result = await run(["--json"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--json requires --check-config");
});
test("incomplete service probe is rejected before loading dependencies", async () => {
  const result = await run([
    "--probe-service",
    "https://example.com",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("Supply --probe-service");
});
test("incomplete challenge policy is rejected before loading dependencies", async () => {
  const result = await run([
    "--check-challenge",
    "https://example.com/v1/test",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("Supply --check-challenge");
});
