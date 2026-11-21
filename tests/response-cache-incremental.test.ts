import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ResponseCacheStore } from "../src/response-caching.js";

const T0 = 1_700_000_000_000;

afterEach(() => setSystemTime());

describe("ResponseCacheStore incremental retention", () => {
  test("set cost stays flat as the live cache grows", () => {
    const small = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 6_000,
    });
    const large = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 6_000,
    });
    for (let i = 0; i < 100; i++) small.set(`s${i}`, "x", 200);
    for (let i = 0; i < 5_000; i++) large.set(`l${i}`, "x", 200);

    const ops = 2_000;
    const measure = (store: ResponseCacheStore) => {
      for (let i = 0; i < 100; i++) store.set("hot", "warm", 200);
      const start = Bun.nanoseconds();
      for (let i = 0; i < ops; i++) store.set("hot", "value", 200);
      return Bun.nanoseconds() - start;
    };

    const smallNs = measure(small);
    const largeNs = measure(large);
    // A full Map clone plus byte sum costs ~50x here. Incremental updates
    // should stay close to a constant factor; leave room for CI noise.
    expect(largeNs).toBeLessThan(smallNs * 5);
  });

  test("overwriting the earliest deadline leaves no stale expiry root", () => {
    setSystemTime(T0);
    const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
    cache.set("a", "short", 200, {}, 0.01);
    cache.set("a", "replacement", 200, {}, 60);

    setSystemTime(T0 + 20);
    cache.set("c", "c", 200);

    expect(cache.get("a")?.body).toBe("replacement");
    expect(cache.get("c")?.body).toBe("c");
  });

  test("expired peers do not evict a live entry at capacity", () => {
    setSystemTime(T0);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 2,
    });
    cache.set("expired", "old", 200, {}, 0.01);
    cache.set("live", "live", 200);

    setSystemTime(T0 + 20);
    cache.set("fresh", "fresh", 200);

    expect(cache.get("expired")).toBeNull();
    expect(cache.get("live")?.body).toBe("live");
    expect(cache.get("fresh")?.body).toBe("fresh");
  });

  test("replacement moves a key to the eviction tail", () => {
    setSystemTime(T0);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 2,
    });
    cache.set("a", "old", 200);
    cache.set("b", "b", 200);
    cache.set("a", "new", 200);
    cache.set("c", "c", 200);

    expect(cache.get("a")?.body).toBe("new");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")?.body).toBe("c");
  });

  test("a failed byte-limit write leaves the live cache and byte budget intact", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 100,
    });
    for (let i = 0; i < 32; i++) cache.set(`big${i}`, big, 200);

    expect(() => cache.set("overflow", "x", 200)).toThrow(
      /Response cache exceeds 32 MiB/,
    );
    for (let i = 0; i < 32; i++) expect(cache.get(`big${i}`)?.body).toBe(big);

    // 31 MiB + a tiny replacement leaves room for one more 1 MiB entry.
    cache.set("big0", "", 200);
    expect(() => cache.set("fits", big, 200)).not.toThrow();
  });

  test("a full cache evicts before checking the byte budget", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 32,
    });
    for (let i = 0; i < 32; i++) cache.set(`k${i}`, big, 200);

    // 32 entries already fill 32 MiB. The staged write evicted k0 before
    // summing bytes, so a same-size replacement was accepted.
    expect(() => cache.set("new", big, 200)).not.toThrow();
    expect(cache.get("k0")).toBeNull();
    expect(cache.get("k1")?.body).toBe(big);
    expect(cache.get("new")?.body).toBe(big);
  });

  test("a rejected write preserves entries whose deadline equals now", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 100,
    });
    cache.set("edge", "A", 200, {}, 0.02); // deadline is exactly T0 + 20
    for (let i = 0; i < 31; i++) cache.set(`live${i}`, big, 200);
    cache.set("almost", "y".repeat(mib - 1), 200);

    setSystemTime(T0 + 20);
    expect(() => cache.set("overflow", big, 200)).toThrow(
      /Response cache exceeds 32 MiB/,
    );
    // get() uses `now > expiresAt`, so an exact-boundary entry stays live.
    expect(cache.get("edge")?.body).toBe("A");
  });

  test("get expiry returns its bytes to the cache budget", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 100,
    });
    cache.set("short", big, 200, {}, 0.01);
    for (let i = 0; i < 31; i++) cache.set(`live${i}`, big, 200);

    setSystemTime(T0 + 20);
    expect(cache.get("short")).toBeNull();
    expect(() => cache.set("replacement", big, 200)).not.toThrow();
  });

  test("clear resets the byte budget and the expiry index", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
    for (let i = 0; i < 32; i++) cache.set(`big${i}`, big, 200);

    cache.clear();
    expect(() => cache.set("after-clear", big, 200)).not.toThrow();
  });
});

interface ReferenceEntry {
  body: string;
  expiresAt: number;
}

class ReferenceCache {
  private cache = new Map<string, ReferenceEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  set(key: string, body: string, now: number, ttlMs: number): string {
    const next = new Map<string, ReferenceEntry>();
    for (const [id, entry] of this.cache) {
      if (id !== key && entry.expiresAt > now) next.set(id, entry);
    }
    if (next.size >= this.maxEntries) {
      const oldest = next.keys().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
    const entry: ReferenceEntry = { body, expiresAt: now + ttlMs };
    next.set(key, entry);
    this.cache = next;
    return body;
  }

  get(key: string, now: number): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.body;
  }
}

describe("ResponseCacheStore differential behaviour", () => {
  test("matches the staged-reference model over mixed operations", () => {
    const keys = Array.from({ length: 6 }, (_, i) => `k${i}`);
    const ttls = [5, 10, 25, 100];
    const actual = new ResponseCacheStore({
      defaultTtlSeconds: 0.1,
      maxEntries: 4,
    });
    const reference = new ReferenceCache(4, 100);
    let seed = 0x4b1d_2026;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    let now = T0;

    const compare = () => {
      setSystemTime(new Date(now));
      for (const key of keys) {
        const expected = reference.get(key, now);
        const received = actual.get(key)?.body ?? null;
        expect(received).toBe(expected);
      }
    };

    for (let step = 0; step < 300; step++) {
      if (random() < 0.65) {
        const key = keys[Math.floor(random() * keys.length)]!;
        const body = `v${step}`;
        const ttlMs = ttls[Math.floor(random() * ttls.length)]!;
        setSystemTime(new Date(now));
        expect(actual.set(key, body, 200, {}, ttlMs / 1000).body).toBe(
          reference.set(key, body, now, ttlMs),
        );
      } else {
        now += Math.floor(random() * 20);
      }
      compare();
    }
  });
});

interface CacheInternals {
  cache: Map<string, { body: string; expiresAt: number }>;
  cachedBytes: number;
  expiries: Array<{ key: string; expiresAt: number }>;
  expiryIndex: Map<string, number>;
}

// The index heap is the riskiest part of this change: a corrupted position or a
// duplicate node can stay invisible through get() until an eviction goes wrong.
// Check the structure directly after each operation instead of waiting for a
// black-box symptom.
function assertIndexInvariants(store: ResponseCacheStore): void {
  const internals = store as unknown as CacheInternals;
  expect(internals.expiries.length).toBe(internals.cache.size);
  expect(internals.expiryIndex.size).toBe(internals.cache.size);
  for (let i = 0; i < internals.expiries.length; i++) {
    const node = internals.expiries[i]!;
    expect(internals.expiryIndex.get(node.key)).toBe(i);
    expect(internals.cache.get(node.key)?.expiresAt).toBe(node.expiresAt);
    if (i > 0)
      expect(internals.expiries[(i - 1) >> 1]!.expiresAt).toBeLessThanOrEqual(
        node.expiresAt,
      );
  }
  let bytes = 0;
  for (const entry of internals.cache.values())
    bytes += Buffer.byteLength(entry.body);
  expect(internals.cachedBytes).toBe(bytes);
}

describe("ResponseCacheStore internal index invariants", () => {
  test("mixed writes, rejections and time advances keep the heap consistent", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 8,
    });
    const keys = ["a", "b", "c", "d", "e"];
    let seed = 0x1234_abcd;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    let now = T0;

    for (let step = 0; step < 200; step++) {
      const key = keys[Math.floor(random() * keys.length)]!;
      const body = random() < 0.15 ? big : `v${step}`;
      const ttl = random() < 0.2 ? 0.02 : 60;
      try {
        cache.set(key, body, 200, {}, ttl);
      } catch (error) {
        expect((error as Error).message).toMatch(/32 MiB/);
      }
      if (random() < 0.1) cache.get(key);
      if (random() < 0.02) cache.clear();
      if (random() < 0.1) {
        now += Math.floor(random() * 30);
        setSystemTime(now);
      }
      assertIndexInvariants(cache);
    }
  });

  test("repeated rejections and a boundary-dated target leave the index rebuildable", () => {
    setSystemTime(T0);
    const mib = 1024 * 1024;
    const big = "x".repeat(mib);
    const cache = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 100,
    });
    for (let i = 0; i < 32; i++) cache.set(`b${i}`, big, 200);
    for (let i = 0; i < 5; i++)
      expect(() => cache.set("overflow", big, 200)).toThrow(/32 MiB/);
    assertIndexInvariants(cache);
    for (let i = 0; i < 32; i++) expect(cache.get(`b${i}`)?.body).toBe(big);

    const edge = new ResponseCacheStore({
      defaultTtlSeconds: 60,
      maxEntries: 100,
    });
    edge.set("target", "A", 200, {}, 0.02);
    for (let i = 0; i < 31; i++) edge.set(`l${i}`, big, 200);
    edge.set("almost", "y".repeat(mib - 1), 200);
    setSystemTime(T0 + 20);
    expect(() => edge.set("target", big, 200)).toThrow(/32 MiB/);
    expect(edge.get("target")?.body).toBe("A");
    assertIndexInvariants(edge);
  });
});
