import { test, expect } from "bun:test";
import { IdempotencyCache } from "../src/idempotency.js";

test.each([NaN, Infinity, 0, -1, 0.5])(
  "invalid per-call TTL %s cannot reserve or publish a response",
  (ttl) => {
    const cache = new IdempotencyCache();
    expect(() => cache.acquire("new", ttl, 1000)).toThrow();
    expect(cache.size()).toBe(0);
    cache.acquire("live", 10, 1000);
    expect(() =>
      cache.complete(
        "live",
        200,
        new Headers(),
        new Uint8Array([1]),
        ttl,
        1000,
      ),
    ).toThrow();
    expect(cache.acquire("live", 10, 1001).status).toBe("in_flight");
  },
);

test.each([NaN, Infinity, -1])(
  "invalid clock %s cannot bypass completed-response expiry",
  (now) => {
    const cache = new IdempotencyCache();
    cache.acquire("key", 10, 1000);
    cache.complete("key", 200, new Headers(), new Uint8Array([1]), 10, 1000);
    expect(() => cache.acquire("key", 10, now)).toThrow();
    expect(() => cache.cleanExpired(now)).toThrow();
    expect(() =>
      cache.complete("key", 200, new Headers(), new Uint8Array([2]), 10, now),
    ).toThrow();
    const live = cache.acquire("key", 10, 1009);
    expect(live.status).toBe("cached");
    if (live.status === "cached") expect([...live.response.body]).toEqual([1]);
  },
);

test("valid TTLs retain leases and expire a completed response at its deadline", () => {
  const cache = new IdempotencyCache();
  expect(cache.acquire("key", 10, 0).status).toBe("acquired");
  expect(cache.acquire("key", 10, 100).status).toBe("in_flight");
  cache.complete("key", 200, new Headers(), new Uint8Array([1]), 10, 100);
  expect(cache.acquire("key", 10, 109).status).toBe("cached");
  expect(cache.acquire("key", 10, 110).status).toBe("acquired");
});
