import { expect, test } from "bun:test";
import { IdempotencyCache, type CachedResponse } from "../src/idempotency.js";
import { harness, signature } from "./helpers.js";
function read(cache: IdempotencyCache, now = 1001): CachedResponse {
  const state = cache.acquire("key", 100, now);
  expect(state.status).toBe("cached");
  if (state.status !== "cached") throw Error("expected cached fixture");
  return state.response;
}
function complete(body: Uint8Array) {
  const cache = new IdempotencyCache();
  cache.acquire("key", 100, 1000);
  cache.complete(
    "key",
    200,
    new Headers({
      "content-type": "text/plain",
      "payment-response": "fixture-only",
    }),
    body,
    100,
    1000,
  );
  return cache;
}
test("retained bytes do not alias an accepted Node Buffer", () => {
  const input = Buffer.from([1, 2]);
  const cache = complete(input);
  input.fill(9);
  expect([...read(cache).body]).toEqual([1, 2]);
});
test("Buffer subviews copy only their visible bytes", () => {
  const backing = Buffer.from([0, 1, 2, 0]);
  const cache = complete(backing.subarray(1, 3));
  backing.fill(9);
  expect([...read(cache).body]).toEqual([1, 2]);
});
test("ordinary Uint8Array input remains independently stored", () => {
  const input = new Uint8Array([1, 2]);
  const cache = complete(input);
  input[0] = 9;
  expect([...read(cache).body]).toEqual([1, 2]);
});
test("returned body, headers and metadata cannot alter later replays", () => {
  const cache = complete(new Uint8Array([1, 2]));
  const first = read(cache);
  first.body.fill(8);
  first.headers[0]![1] = "poisoned";
  first.headers.push(["x-private", "poisoned"]);
  first.statusCode = 500;
  first.cachedAt = 0;
  first.expiresAt = 0;
  const retained = read(cache, 1002);
  expect(retained.statusCode).toBe(200);
  expect([...retained.body]).toEqual([1, 2]);
  expect(retained.headers).toEqual([
    ["content-type", "text/plain"],
    ["payment-response", "fixture-only"],
  ]);
  expect(retained.cachedAt).toBe(1000);
  expect(retained.expiresAt).toBe(1100);
});
test("each cached read owns distinct nested response data", () => {
  const cache = complete(new Uint8Array([1]));
  const a = read(cache),
    b = read(cache);
  expect(a).not.toBe(b);
  expect(a.body).not.toBe(b.body);
  expect(a.headers).not.toBe(b.headers);
  expect(a.headers[0]).not.toBe(b.headers[0]);
});
test("completion still snapshots header values and preserves expiry", () => {
  const cache = new IdempotencyCache();
  const headers = new Headers({
    "content-type": "text/plain",
    authorization: "not-retained",
  });
  cache.acquire("key", 100, 1000);
  cache.complete("key", 200, headers, new Uint8Array([1]), 100, 1000);
  headers.set("content-type", "changed");
  expect(read(cache).headers).toEqual([["content-type", "text/plain"]]);
  expect(cache.acquire("key", 100, 1100).status).toBe("acquired");
});
test("mocked paid HTTP replay still executes verify/upstream/settle once", async () => {
  const { app, events } = harness({
    upstream: async () => new Response(Buffer.from("protected")),
  });
  const headers = {
    "payment-signature": await signature(app),
    "idempotency-key": "bytes-owned",
  };
  for (let i = 0; i < 2; i++) {
    const r = await app.request("/v1/echo", { headers });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("protected");
    expect(r.headers.get("idempotent-replayed")).toBe(i ? "true" : null);
  }
  expect(events).toEqual(["verify", "upstream", "settle"]);
});
