import { expect, test } from "bun:test";
import { IdempotencyCache } from "../src/idempotency.js";

const body = (n: number) => new Uint8Array(n);
const headers = new Headers({ "content-type": "application/json" });

test("bytes tracks completed bodies only", () => {
  const cache = new IdempotencyCache();
  expect(cache.bytes()).toBe(0);

  cache.acquire("a");
  // A reservation holds no response yet.
  expect(cache.bytes()).toBe(0);

  cache.complete("a", 200, headers, body(120));
  expect(cache.bytes()).toBe(120);

  // Releasing an in-flight reservation must not disturb the accounting.
  cache.acquire("b");
  cache.release("b");
  expect(cache.bytes()).toBe(120);

  cache.acquire("c");
  cache.complete("c", 200, headers, body(80));
  expect(cache.bytes()).toBe(200);
});

test("a completion over the byte budget is dropped and accounts for nothing", () => {
  const cache = new IdempotencyCache({ maxBytes: 100 });
  cache.acquire("a");
  cache.complete("a", 200, headers, body(60));
  expect(cache.bytes()).toBe(60);

  cache.acquire("b");
  cache.complete("b", 200, headers, body(50));
  // 60 + 50 exceeds 100, so the response is not cached and the budget is intact.
  expect(cache.bytes()).toBe(60);
  expect(cache.size()).toBe(1);

  // Because nothing was cached, the retry is admitted again instead of replaying.
  expect(cache.acquire("b").status).toBe("acquired");
});

test("a completion that exactly fills the budget is kept", () => {
  const cache = new IdempotencyCache({ maxBytes: 100 });
  cache.acquire("a");
  cache.complete("a", 200, headers, body(60));
  cache.acquire("b");
  cache.complete("b", 200, headers, body(40));

  expect(cache.bytes()).toBe(100);
  expect(cache.size()).toBe(2);
});

test("replacing a completed record does not double count its body", () => {
  const cache = new IdempotencyCache({ maxBytes: 100 });
  cache.acquire("a");
  cache.complete("a", 200, headers, body(80));
  expect(cache.bytes()).toBe(80);

  // The replaced body leaves the budget first, so an equal-size replacement fits.
  cache.complete("a", 200, headers, body(80));
  expect(cache.bytes()).toBe(80);
  expect(cache.size()).toBe(1);
});

test("expiry releases the body budget", () => {
  const cache = new IdempotencyCache({ maxBytes: 100 });
  const now = 1_000_000;
  cache.acquire("a", 500, now);
  cache.complete("a", 200, headers, body(80), 500, now);
  expect(cache.bytes()).toBe(80);

  cache.cleanExpired(now + 500);
  expect(cache.size()).toBe(0);
  expect(cache.bytes()).toBe(0);
});

test("acquiring past the TTL releases the entry without sweeping the cache", () => {
  const cache = new IdempotencyCache();
  const now = 1_000_000;
  cache.acquire("stale", 500, now);
  cache.complete("stale", 200, headers, body(64), 500, now);
  cache.acquire("live", 500, now);
  cache.complete("live", 200, headers, body(32), 500, now);

  // Only the expired key is reclaimed; the other completed record is untouched.
  expect(cache.acquire("stale", 500, now + 500).status).toBe("acquired");
  expect(cache.bytes()).toBe(32);
  expect(cache.size()).toBe(2);
});

test("capacity eviction releases the evicted body", () => {
  const cache = new IdempotencyCache({ maxKeys: 2 });
  cache.acquire("a");
  cache.complete("a", 200, headers, body(10));
  cache.acquire("b");
  cache.complete("b", 200, headers, body(20));
  expect(cache.bytes()).toBe(30);

  cache.acquire("c");
  expect(cache.size()).toBe(2);
  // Oldest completion leaves first, and its bytes stop being accounted.
  expect(cache.bytes()).toBe(20);
});

test("capacity pressure never discards a live reservation", () => {
  const cache = new IdempotencyCache({ maxKeys: 1 });
  cache.acquire("held", 1_000, 0);

  // Nothing is evictable, so the request is refused rather than losing the lease.
  expect(cache.acquire("other", 1_000, 10).status).toBe("conflict");
  expect(cache.acquire("held", 1_000, 10).status).toBe("in_flight");
});

test("clear resets records, accounting and the eviction index", () => {
  const cache = new IdempotencyCache({ maxKeys: 2 });
  cache.acquire("a");
  cache.complete("a", 200, headers, body(10));
  cache.acquire("b");
  cache.complete("b", 200, headers, body(20));

  cache.clear();
  expect(cache.size()).toBe(0);
  expect(cache.bytes()).toBe(0);

  // The eviction index must be empty too: a fresh fill works after clear.
  cache.acquire("c");
  cache.complete("c", 200, headers, body(5));
  expect(cache.bytes()).toBe(5);
});

test("accounting survives a mixed sequence", () => {
  const cache = new IdempotencyCache({ maxKeys: 3, maxBytes: 1_000 });
  const now = 1_000_000;

  cache.acquire("a", 100, now);
  cache.complete("a", 200, headers, body(10), 100, now);
  cache.acquire("b", 100, now);
  cache.complete("b", 200, headers, body(20), 100, now);
  cache.acquire("c", 100, now);
  // c stays in flight, then is abandoned.
  cache.release("c");

  expect(cache.bytes()).toBe(30);

  // Both completed records lapse; each acquisition reclaims only its own key.
  expect(cache.acquire("a", 100, now + 100).status).toBe("acquired");
  expect(cache.bytes()).toBe(20);
  expect(cache.acquire("b", 100, now + 100).status).toBe("acquired");
  expect(cache.bytes()).toBe(0);
});
