import { expect, test } from "bun:test";
import { createApp } from "../src/index.js";
import { harness, signature, supported, testConfig, PAYER } from "./helpers.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a burst admits only capacity and rejects overflow before payment verification", async () => {
  const entered = gate();
  const unblock = gate();
  let arrivals = 0;
  const { app, events } = harness({
    env: { MAX_CONCURRENT_REQUESTS: "2" },
    upstream: async () => {
      if (++arrivals === 2) entered.release();
      await unblock.promise;
      return Response.json({ ok: true });
    },
  });
  const headers = { "payment-signature": await signature(app) };
  const first = app.request("/v1/echo", { headers });
  const second = app.request("/v1/echo", { headers });
  try {
    await entered.promise;
    const overflow = await Promise.all(
      Array.from({ length: 20 }, () => app.request("/v1/echo", { headers })),
    );
    for (const response of overflow) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "service_busy" });
    }
    expect(events.filter((x) => x === "verify")).toHaveLength(2);
    expect(events.filter((x) => x === "upstream")).toHaveLength(2);
    expect((await app.request("/healthz")).status).toBe(200);
  } finally {
    unblock.release();
  }
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect((await app.request("/v1/echo", { headers })).status).toBe(200);
});

test("capacity remains reserved until settlement completes", async () => {
  const entered = gate();
  const unblock = gate();
  const { app } = harness({
    env: { MAX_CONCURRENT_REQUESTS: "1" },
    facilitator: {
      settle: async () => {
        entered.release();
        await unblock.promise;
        return {
          success: true,
          transaction: "mock",
          network: "eip155:2368",
          payer: PAYER,
        };
      },
    },
  });
  const headers = { "payment-signature": await signature(app) };
  const first = app.request("/v1/echo", { headers });
  try {
    await entered.promise;
    expect((await app.request("/v1/echo", { headers })).status).toBe(503);
  } finally {
    unblock.release();
  }
  expect((await first).status).toBe(200);
  expect((await app.request("/v1/echo", { headers })).status).toBe(200);
});

test("initialization is shared and also bounded; other app instances stay independent", async () => {
  const entered = gate();
  const unblock = gate();
  let calls = 0;
  const { app } = harness({
    env: { MAX_CONCURRENT_REQUESTS: "2" },
    facilitator: {
      getSupported: async () => {
        calls++;
        entered.release();
        await unblock.promise;
        return supported;
      },
    },
  });
  const first = app.request("/v1/echo");
  const second = app.request("/v1/echo");
  try {
    await entered.promise;
    expect((await app.request("/v1/echo")).status).toBe(503);
    expect((await harness().app.request("/v1/echo")).status).toBe(402);
    expect(calls).toBe(1);
  } finally {
    unblock.release();
  }
  expect((await first).status).toBe(402);
  expect((await second).status).toBe(402);
});

test("all failure paths release capacity", async () => {
  const cases = [
    { valid: false },
    { settles: false },
    {
      upstream: async () => {
        throw new Error("offline");
      },
    },
    { upstream: async () => new Response(null, { status: 500 }) },
    {
      facilitator: {
        verify: async () => {
          throw new Error("verify offline");
        },
      },
    },
    {
      facilitator: {
        settle: async () => {
          throw new Error("settle offline");
        },
      },
    },
  ];
  for (const options of cases) {
    const { app } = harness({
      ...options,
      env: { MAX_CONCURRENT_REQUESTS: "1" },
    });
    const headers = { "payment-signature": await signature(app) };
    expect(
      (await app.request("/v1/echo", { headers })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await app.request("/v1/echo")).status).toBe(402);
  }
  const { app } = harness({
    env: { MAX_CONCURRENT_REQUESTS: "1" },
    facilitator: {
      getSupported: async () => {
        throw new Error("offline");
      },
    },
  });
  for (let i = 0; i < 3; i++)
    expect(await (await app.request("/v1/echo")).json()).toEqual({
      error: "facilitator_unavailable",
    });
});

test("capacity config rejects invalid values and old programmatic configs keep working", async () => {
  expect(testConfig().maxConcurrentRequests).toBe(64);
  for (const value of ["0", "-1", "1.5", "10001", "NaN"])
    expect(() => testConfig({ MAX_CONCURRENT_REQUESTS: value })).toThrow();
  const config = testConfig();
  delete config.maxConcurrentRequests;
  expect((await createApp(config).request("/healthz")).status).toBe(200);
  expect(() => createApp({ ...config, maxConcurrentRequests: NaN })).toThrow();
});
