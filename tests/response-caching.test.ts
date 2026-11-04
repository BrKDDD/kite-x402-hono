import { describe, it, expect } from "bun:test";
import { ResponseCacheStore } from "../src/response-caching.js";

describe("ResponseCacheStore", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });

  it("sets and retrieves cached responses with valid ETag", () => {
    const key = cache.generateKey("GET", "/v1/data");
    const entry = cache.set(key, JSON.stringify({ ok: true }), 200);

    expect(entry.etag).toBeDefined();
    const fetched = cache.get(key);
    expect(fetched).not.toBeNull();
    expect(fetched?.body).toBe(JSON.stringify({ ok: true }));
  });

  it("expires stale entries after TTL", async () => {
    const shortCache = new ResponseCacheStore({ defaultTtlSeconds: 0.05 });
    const key = shortCache.generateKey("GET", "/v1/short");
    shortCache.set(key, "data", 200, {}, 0.02);

    await new Promise((r) => setTimeout(r, 30));
    expect(shortCache.get(key)).toBeNull();
  });
});
