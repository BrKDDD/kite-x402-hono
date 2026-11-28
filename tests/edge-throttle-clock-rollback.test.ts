import { expect, test } from "bun:test";
import { EdgeRateThrottler } from "../src/middleware/edge-rate-throttler.js";

interface MemoryBackend {
  readonly get: (key: string) => Promise<number | null>;
  readonly increment: (key: string, ttlSeconds: number) => Promise<number>;
  readonly keys: () => string[];
  readonly counts: () => Map<string, number>;
}

function memoryBackend(): MemoryBackend {
  const store = new Map<string, number>();
  return {
    get: async (key) => store.get(key) ?? null,
    increment: async (key, _ttlSeconds) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    keys: () => [...store.keys()],
    counts: () => new Map(store),
  };
}

test("clock rollback into a previous window keeps the same client throttled", async () => {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(backend, 2, 60, () => now);

  expect(await limiter.isAllowed("client")).toEqual({
    allowed: true,
    remaining: 1,
  });
  expect(await limiter.isAllowed("client")).toEqual({
    allowed: true,
    remaining: 0,
  });
  expect(await limiter.isAllowed("client")).toEqual({
    allowed: false,
    remaining: 0,
  });
  const keysBefore = backend.keys();
  expect(keysBefore).toHaveLength(1);

  // Roll back by more than one whole window. The old implementation derives a
  // brand-new key from the wall clock and hands the client a fresh quota.
  now -= 120_000;
  expect(await limiter.isAllowed("client")).toEqual({
    allowed: false,
    remaining: 0,
  });
  expect(backend.keys()).toEqual(keysBefore);
  expect(backend.counts().get(keysBefore[0]!)).toBe(4);
});

test("arbitrarily large rollbacks never reset a spent quota", async () => {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(backend, 1, 60, () => now);

  expect((await limiter.isAllowed("client")).allowed).toBe(true);
  expect((await limiter.isAllowed("client")).allowed).toBe(false);

  for (const back of [120_001, 180_000, 3_600_000]) {
    now -= back;
    expect((await limiter.isAllowed("client")).allowed).toBe(false);
    now += back;
  }
  expect(backend.keys()).toHaveLength(1);
});

test("forward clock spike cannot permanently pin a client", async () => {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(backend, 1, 60, () => now);

  expect((await limiter.isAllowed("client")).allowed).toBe(true);

  // A transient spike raises the high-water mark. Because the mark never
  // falls back, the client is throttled in the spike window, but genuine
  // forward time still opens new windows after it catches up.
  now += 3_600_000;
  expect((await limiter.isAllowed("client")).allowed).toBe(true);
  expect((await limiter.isAllowed("client")).allowed).toBe(false);

  now += 60_000;
  expect((await limiter.isAllowed("client")).allowed).toBe(true);
});

test("clock advance opens a fresh window", async () => {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(backend, 1, 60, () => now);

  expect((await limiter.isAllowed("client")).allowed).toBe(true);
  expect((await limiter.isAllowed("client")).allowed).toBe(false);

  now += 60_000;
  expect((await limiter.isAllowed("client")).allowed).toBe(true);
  expect(backend.keys()).toHaveLength(2);
});

test("quota clamping is isolated per client", async () => {
  let now = 1_700_000_000_000;
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(backend, 1, 60, () => now);

  expect((await limiter.isAllowed("a")).allowed).toBe(true);
  expect((await limiter.isAllowed("b")).allowed).toBe(true);

  now -= 60_000;
  expect((await limiter.isAllowed("a")).allowed).toBe(false);
  expect((await limiter.isAllowed("b")).allowed).toBe(false);
  expect(backend.keys()).toHaveLength(2);
});

test("invalid clock readings fail closed", async () => {
  const backend = memoryBackend();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const limiter = new EdgeRateThrottler(backend, 2, 60, () => bad);
    await expect(limiter.isAllowed("client")).rejects.toThrow(
      "Invalid edge clock",
    );
  }
  expect(backend.keys()).toHaveLength(0);
});

test("finite but unsafe clock readings fail closed", async () => {
  const backend = memoryBackend();
  for (const bad of [Number.MAX_VALUE, 1e21, Number.MIN_SAFE_INTEGER - 1]) {
    const limiter = new EdgeRateThrottler(backend, 2, 60, () => bad);
    await expect(limiter.isAllowed("client")).rejects.toThrow(
      "Invalid edge clock",
    );
  }
  expect(backend.keys()).toHaveLength(0);
});

test("capacity is fail-closed without evicting an incumbent", async () => {
  const backend = memoryBackend();
  const limiter = new EdgeRateThrottler(
    backend,
    2,
    60,
    () => 1_700_000_000_000,
    2,
  );

  expect((await limiter.isAllowed("a")).allowed).toBe(true);
  expect((await limiter.isAllowed("b")).allowed).toBe(true);
  expect(await limiter.isAllowed("c")).toEqual({
    allowed: false,
    remaining: 0,
  });
  expect(backend.keys()).toHaveLength(2);

  // The incumbent is still tracked after a rollback; no flood can erase it.
  for (const id of ["d", "e", "f"]) await limiter.isAllowed(id);
  expect(
    (
      limiter as unknown as { highWaterByClient: Map<string, number> }
    ).highWaterByClient.has("a"),
  ).toBe(true);
});

test("constructor rejects invalid limits", () => {
  const ok = memoryBackend();
  expect(() => new EdgeRateThrottler(ok, 2, 60, null as never)).toThrow(
    "Invalid edge limits",
  );
  expect(() => new EdgeRateThrottler(ok, 2, 60, () => 0, 0)).toThrow(
    "Invalid edge limits",
  );
});

test("malformed backend counter still rejects", async () => {
  const limiter = new EdgeRateThrottler(
    {
      get: async () => null,
      increment: async () => Number.NaN,
    },
    2,
    60,
    () => 1_700_000_000_000,
  );
  await expect(limiter.isAllowed("client")).rejects.toThrow();
});
