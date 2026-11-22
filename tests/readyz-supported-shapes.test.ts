import { expect, test } from "bun:test";
import { harness } from "./helpers.js";
const kind = { network: "eip155:2368", scheme: "exact", x402Version: 2 };
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
async function unavailable(value: unknown) {
  const { app, events } = harness({
    facilitator: { getSupported: async () => wire(value) },
  });
  const r = await app.request("/readyz");
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({
    ok: false,
    error: "facilitator_unavailable",
  });
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(events).toEqual([]);
}
test("malformed supported containers report unavailable instead of internal error", async () => {
  for (const value of [
    null,
    {},
    [],
    { kinds: null },
    { kinds: {} },
    { kinds: "invalid" },
  ])
    await unavailable(value);
});
test("malformed kind entries are handled inside the availability boundary", async () => {
  for (const entry of [
    null,
    1,
    {},
    { ...kind, network: 1 },
    { ...kind, scheme: null },
    { ...kind, x402Version: "2" },
    { ...kind, x402Version: 1.5 },
    { ...kind, x402Version: 0 },
  ])
    await unavailable({ kinds: [entry] });
});
test("a valid alternative cannot hide a malformed supported entry", async () => {
  await unavailable({ kinds: [kind, null] });
});
test("valid but unmatched offerings retain network_not_offered", async () => {
  for (const kinds of [
    [],
    [{ ...kind, x402Version: 1 }],
    [{ ...kind, scheme: "other" }],
    [{ ...kind, network: "eip155:9999" }],
  ]) {
    const { app, events } = harness({
      facilitator: { getSupported: async () => wire({ kinds }) },
    });
    const r = await app.request("/readyz");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      ok: false,
      error: "network_not_offered",
      network: kind.network,
    });
    expect(events).toEqual([]);
  }
});
test("valid mainnet/testnet advertisements and unknown extra fields stay accepted", async () => {
  for (const network of ["mainnet", "testnet"]) {
    const chain = network === "mainnet" ? "eip155:2366" : "eip155:2368";
    const { app, events } = harness({
      env: { KITE_NETWORK: network },
      facilitator: {
        getSupported: async () =>
          wire({
            kinds: [{ ...kind, network: chain, extra: { future: true } }],
            future: "allowed",
          }),
      },
    });
    const r = await app.request("/readyz");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.network).toBe(chain);
    expect(body.asset).toBe(network === "mainnet" ? "USDC.e" : "pieUSD");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(events).toEqual([]);
  }
});
test("maintenance still short-circuits malformed facilitator data", async () => {
  let calls = 0;
  const { app, events } = harness({
    env: { MAINTENANCE_MODE: "true" },
    facilitator: {
      getSupported: async () => {
        calls++;
        return wire(null);
      },
    },
  });
  const r = await app.request("/readyz");
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ ok: false, error: "maintenance_mode" });
  expect(calls).toBe(0);
  expect(events).toEqual([]);
});
test("rejected calls expose only the existing unavailable diagnostic", async () => {
  const { app, events } = harness({
    facilitator: {
      getSupported: async () => {
        throw Error("private diagnostic fixture");
      },
    },
  });
  const r = await app.request("/readyz");
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({
    ok: false,
    error: "facilitator_unavailable",
  });
  expect(events).toEqual([]);
});
test("a malformed response does not poison later valid readiness checks", async () => {
  let calls = 0;
  const { app, events } = harness({
    facilitator: {
      getSupported: async () => wire(calls++ ? { kinds: [kind] } : null),
    },
  });
  expect((await app.request("/readyz")).status).toBe(503);
  expect((await app.request("/readyz")).status).toBe(200);
  expect(calls).toBe(2);
  expect(events).toEqual([]);
});
