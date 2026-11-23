import { expect, test, spyOn } from "bun:test";
import { fileURLToPath } from "node:url";
import { runDeliveryAcceptance } from "../src/delivery-acceptance.js";

test("delivery acceptance checks HTTP outcomes and simulated call order", async () => {
  const r = await runDeliveryAcceptance();
  expect(r.ok).toBe(true);
  expect(r.scope).toBe("simulated-delivery-only");
  expect(r.scenarios).toEqual([
    { name: "unpaid", ok: true, status: 402, events: [] },
    { name: "invalid_payment", ok: true, status: 402, events: ["verify"] },
    {
      name: "success",
      ok: true,
      status: 200,
      events: ["verify", "upstream", "settle"],
    },
    {
      name: "upstream_failure",
      ok: true,
      status: 503,
      events: ["verify", "upstream"],
    },
    {
      name: "settlement_refused",
      ok: true,
      status: 402,
      events: ["verify", "upstream", "settle"],
    },
  ]);
});
test("delivery runs are independent and repeatable", async () => {
  const [a, b] = await Promise.all([
    runDeliveryAcceptance(),
    runDeliveryAcceptance(),
  ]);
  expect(a.ok).toBe(true);
  expect(a).toEqual(b);
});
test("binding errors fail all cases without disclosing raw errors", async () => {
  const mock = spyOn(Bun, "serve").mockImplementation(() => {
    throw new Error("PRIVATE");
  });
  try {
    const r = await runDeliveryAcceptance();
    expect(r.ok).toBe(false);
    expect(r.scenarios.every((s) => !s.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("PRIVATE");
  } finally {
    mock.mockRestore();
  }
});
test("standalone delivery uses isolated config, reports JSON and exits", async () => {
  const p = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/delivery-acceptance.ts", import.meta.url)),
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        KITE_NETWORK: "invalid",
        PAY_TO: "private",
        MAINTENANCE_MODE: "true",
      },
    },
  );
  const timer = setTimeout(() => p.kill(), 15000);
  try {
    const output = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(JSON.parse(output).ok).toBe(true);
    expect(output).not.toContain("private");
  } finally {
    clearTimeout(timer);
    p.kill();
  }
});
