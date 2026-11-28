import { expect, test } from "bun:test";
import { ResponseCacheStore } from "../src/response-caching.js";

// 模拟未经过 TypeScript 约束的 JS 调用方；失败应保留旧缓存，而非接收该值。
const invalidHeaders = () => ({
  "content-type": (() => "text/plain") as unknown as string,
});

test("clone failure cannot replace a live response with an unreadable entry", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  const original = cache.set("paid", "original", 200, {
    "content-type": "text/plain",
  });
  expect(() =>
    cache.set("paid", "replacement", 201, invalidHeaders()),
  ).toThrow();
  expect(cache.get("paid")).toEqual(original);
});

test("clone failure at capacity cannot evict another paid response", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 1,
  });
  cache.set("paid", "original", 200);
  expect(() =>
    cache.set("other", "replacement", 201, invalidHeaders()),
  ).toThrow();
  expect(cache.get("paid")?.body).toBe("original");
  expect(cache.get("other")).toBeNull();
});

test("failed replacement leaves FIFO order and later valid writes intact", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 2,
  });
  cache.set("first", "one", 200);
  cache.set("second", "two", 200);
  expect(() => cache.set("first", "bad", 201, invalidHeaders())).toThrow();
  cache.set("third", "three", 200);
  expect(cache.get("second")?.body).toBe("two");
  expect(cache.get("first")).toBeNull();
  expect(cache.get("third")?.body).toBe("three");
});

test("successful writes still return an independent snapshot and copy input headers", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  const headers = { "content-type": "text/plain" };
  const result = cache.set("paid", "original", 200, headers);
  headers["content-type"] = "changed-input";
  result.body = "changed-output";
  result.headers["content-type"] = "changed-output";
  expect(cache.get("paid")?.body).toBe("original");
  expect(cache.get("paid")?.headers["content-type"]).toBe("text/plain");
});
