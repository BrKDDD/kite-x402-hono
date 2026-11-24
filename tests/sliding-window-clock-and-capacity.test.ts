import { expect, test } from "bun:test";
import {
  SlidingWindowLimiter,
  type RateLimitResult,
} from "../src/middleware/sliding-window-limiter.js";

function runAt<T>(now: number, fn: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function internalWindows(limiter: SlidingWindowLimiter): Map<string, number[]> {
  return (limiter as unknown as { windows: Map<string, number[]> }).windows;
}

function internalExpiries(
  limiter: SlidingWindowLimiter,
): Array<{ key: string; expiresAt: number }> {
  return (
    limiter as unknown as {
      expiries: Array<{ key: string; expiresAt: number }>;
    }
  ).expiries;
}

test("clock rollback does not clear an active window or grant a fresh quota", () => {
  runAt(0, () => {
    const original = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const limiter = new SlidingWindowLimiter(60_000, 2);
      now = 1_000_000;
      expect(limiter.check("victim").allowed).toBe(true);
      now = 1_000_050;
      expect(limiter.check("victim").allowed).toBe(true);
      expect(limiter.check("victim").allowed).toBe(false);

      // NTP step backwards: the new timestamp must not make at(-1) the maximum.
      now = 900_000;
      const afterRollback = limiter.check("victim");
      expect(afterRollback.allowed).toBe(false);
      expect(afterRollback.remaining).toBe(0);

      // Advancing past the rolled-back value must not evict the future entries.
      now = 960_000;
      expect(limiter.check("other").allowed).toBe(true);
      expect(internalWindows(limiter).has("victim")).toBe(true);
      expect(limiter.check("victim").allowed).toBe(false);
    } finally {
      Date.now = original;
    }
  });
});

test("timestamps stay ascending across a backward step", () => {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const limiter = new SlidingWindowLimiter(60_000, 5);
    now = 1_000_000;
    limiter.check("k");
    now = 950_000;
    limiter.check("k");
    now = 1_000_010;
    limiter.check("k");
    // The rollback insert is clamped to the newest recorded timestamp.
    const times = internalWindows(limiter).get("k")!;
    expect(times).toEqual([1_000_000, 1_000_000, 1_000_010]);
  } finally {
    Date.now = original;
  }
});

test("expired keys are reclaimed and their heap entries removed", () => {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const limiter = new SlidingWindowLimiter(1_000, 5, 10);
    limiter.check("old");
    now = 1_001_500; // beyond 1_000_000 + 1000ms window
    limiter.check("fresh");
    expect(internalWindows(limiter).has("old")).toBe(false);
    expect(internalExpiries(limiter).map((entry) => entry.key)).toEqual([
      "fresh",
    ]);
  } finally {
    Date.now = original;
  }
});

test("heap reclamation matches a full-scan reference over mixed clocks", () => {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const limiter = new SlidingWindowLimiter(5_000, 2, 1000);

    // Naive oracle: a plain Map with an O(n) sweep, independent of the heap.
    const reference = new Map<string, number[]>();
    const oracle = (key: string, at: number): boolean => {
      const cutoff = at - 5_000;
      for (const [id, times] of reference) {
        if ((times[times.length - 1] ?? 0) <= cutoff) reference.delete(id);
      }
      const live = (reference.get(key) ?? []).filter((t) => t > cutoff);
      if (live.length >= 2) {
        reference.set(key, live);
        return false;
      }
      const effectiveNow = Math.max(at, live[live.length - 1] ?? at);
      reference.set(
        key,
        [...live, effectiveNow].sort((a, b) => a - b),
      );
      return true;
    };

    let seed = 11;
    const random = (): number =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let step = 0; step < 3_000; step++) {
      now += Math.floor(random() * 400) - 120; // includes backward steps
      const key = `k${Math.floor(random() * 40)}`;
      const shouldAllow = oracle(key, now);
      const result = limiter.check(key);
      expect(result.allowed, `step ${step} ${key} now=${now}`).toBe(
        shouldAllow,
      );

      if (step % 97 === 0) {
        const implKeys = [...internalWindows(limiter).keys()].sort();
        expect(implKeys, `key set at step ${step}`).toEqual(
          [...reference.keys()].sort(),
        );
        for (const [id, times] of reference) {
          expect(internalWindows(limiter).get(id), `times for ${id}`).toEqual(
            times,
          );
        }
      }
    }
  } finally {
    Date.now = original;
  }
});

test("capacity is configurable and stays fail-closed for new keys", () => {
  runAt(1_000_000, () => {
    const limiter = new SlidingWindowLimiter(60_000, 5, 3);
    limiter.check("a");
    limiter.check("b");
    limiter.check("c");
    const denied = limiter.check("new");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Incumbents keep working — no LRU eviction.
    expect(limiter.check("a").allowed).toBe(true);
    expect(internalWindows(limiter).has("new")).toBe(false);
  });
});

test("default capacity remains 10000", () => {
  runAt(1_000_000, () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 10_000; i++) limiter.check(`k${i}`);
    expect(limiter.check("overflow").allowed).toBe(false);
  });
});

test("rejected checks stay flat as the live key set grows", () => {
  const measure = (count: number): number => {
    const limiter = new SlidingWindowLimiter(60_000, 1, count + 1);
    for (let i = 0; i < count; i++) limiter.check(`seed-${i}`);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) limiter.check(`fresh-${i}`);
    return ((performance.now() - start) * 1000) / 1000;
  };
  const small = measure(100);
  const large = measure(10_000);
  expect(large).toBeLessThan(Math.max(small * 5, 20));
});

test("resetSeconds is based on the true oldest live timestamp after rollback", () => {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const limiter = new SlidingWindowLimiter(10_000, 1);
    now = 1_000_000;
    limiter.check("k"); // full
    now = 990_000; // rollback — clamped to the recorded 1_000_000
    limiter.check("k"); // still full
    now = 995_000;
    const denied: RateLimitResult = limiter.check("k");
    expect(denied.allowed).toBe(false);
    // Oldest live is 1_000_000; window ends at 1_010_000, 15s from now.
    expect(denied.resetSeconds).toBe(15);
  } finally {
    Date.now = original;
  }
});

test("constructor validates every limit", () => {
  expect(() => new SlidingWindowLimiter(0)).toThrow("Invalid window limits");
  expect(() => new SlidingWindowLimiter(1, 0)).toThrow("Invalid window limits");
  expect(() => new SlidingWindowLimiter(1, 1, 1.5)).toThrow(
    "Invalid window limits",
  );
  expect(() => new SlidingWindowLimiter(1, 1, -1)).toThrow(
    "Invalid window limits",
  );
  expect(() => new SlidingWindowLimiter(Number.MAX_SAFE_INTEGER + 1)).toThrow(
    "Invalid window limits",
  );
});
