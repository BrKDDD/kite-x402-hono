import { test, expect } from "bun:test";
import { Hono } from "hono";
import { ReceiptMemoryCache, corsAllowlistValidator } from "../src/index.js";
const receipt = (id: string) => ({
  receiptId: id,
  payer: "alice",
  amount: "9007199254740993",
  timestamp: 1,
});
test("receipt LRU, replacement and copies preserve independent entries", () => {
  const cache = new ReceiptMemoryCache(1000, 2);
  const input = receipt("a");
  cache.set("a", input);
  input.payer = "changed";
  cache.set("b", receipt("b"));
  const output = cache.get("a")!;
  output.payer = "changed";
  cache.set("c", receipt("c"));
  expect(cache.has("b")).toBe(false);
  expect(cache.get("a")?.payer).toBe("alice");
  cache.set("a", receipt("a"));
  expect(cache.has("c")).toBe(true);
  expect(() => cache.set("a", receipt("a"), NaN)).toThrow();
  expect(cache.get("a")?.amount).toBe("9007199254740993");
  expect(() =>
    cache.set("x", { ...receipt("x"), amount: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  expect(() => new ReceiptMemoryCache(0)).toThrow();
});
test("expired receipts are reclaimed at the exact boundary", () => {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const cache = new ReceiptMemoryCache(10, 2);
    cache.set("live", receipt("live"), 100);
    cache.set("old", receipt("old"));
    now += 10;
    cache.set("new", receipt("new"));
    expect(cache.has("old")).toBe(false);
    expect(cache.has("live")).toBe(true);
    now += 10;
    expect(cache.get("new")).toBeNull();
  } finally {
    Date.now = original;
  }
});
function appFixture() {
  const app = new Hono();
  const pattern = /https:\/\/[a-z]+\.kite\.ai/g;
  app.use(corsAllowlistValidator({ allowedDomains: [pattern] }));
  app.all("/*", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Vary", "Accept-Encoding");
    return c.json({ error: "payment_required" }, 402);
  });
  return app;
}
test("ordinary OPTIONS remains paid and denied origins cannot inherit CORS", async () => {
  const app = appFixture();
  for (const headers of [{}, { origin: "https://app.kite.ai" }])
    expect(
      (await app.request("/", { method: "OPTIONS", headers })).status,
    ).toBe(402);
  for (const origin of [
    "https://app.kite.ai.evil.com",
    "null",
    "https://app.kite.ai/path",
  ]) {
    const res = await app.request("/", { headers: { origin } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  }
});
test("preflight validates methods, origins and current payment headers", async () => {
  const app = appFixture();
  const headers = {
    origin: "https://app.kite.ai",
    "access-control-request-method": "POST",
    "access-control-request-headers": "Payment-Signature, Idempotency-Key",
  };
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/", { method: "OPTIONS", headers });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  }
  for (const extra of [
    { origin: "https://evil.com" },
    { "access-control-request-method": "TRACE" },
    { "access-control-request-headers": "X-Evil" },
  ])
    expect(
      (
        await app.request("/", {
          method: "OPTIONS",
          headers: { ...headers, ...extra },
        })
      ).status,
    ).toBe(403);
  const res = await app.request("/", { headers: { origin: headers.origin } });
  expect(res.headers.get("access-control-expose-headers")).toContain(
    "Payment-Required",
  );
  expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
});
