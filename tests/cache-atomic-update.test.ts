import { expect, test } from "bun:test";
import { ResponseCacheStore } from "../src/response-caching.js";

test("an invalid replacement preserves the previous response", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  cache.set("paid", "original", 200);
  for (const ttl of [0, -1, NaN, Infinity]) {
    expect(() => cache.set("paid", "replacement", 200, {}, ttl)).toThrow();
    expect(cache.get("paid")?.body).toBe("original");
  }
});

test("invalid insertion into a full cache cannot evict another response", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 1,
  });
  cache.set("", "original", 200);
  expect(() => cache.set("other", "bad", 200, {}, 0)).toThrow();
  expect(cache.get("")?.body).toBe("original");
  cache.set("other", "valid", 201);
  expect(cache.get("")).toBeNull();
  expect(cache.get("other")?.body).toBe("valid");
});

test("successful replacements retain copied headers and results", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  cache.set("paid", "old", 200);
  const replacement = cache.set(
    "paid",
    "new",
    201,
    { "content-type": "text/plain" },
    10,
  );
  replacement.body = "mutated";
  expect(cache.get("paid")?.body).toBe("new");
  expect(cache.get("paid")?.headers["content-type"]).toBe("text/plain");
});
