import { describe, expect, test } from "bun:test";

import {
  ReceiptMemoryCache,
  type CachedReceipt,
} from "../src/services/receiptMemoryCache.js";

function receipt(overrides: Partial<CachedReceipt> = {}): CachedReceipt {
  return {
    receiptId: "r",
    payer: "0xabc",
    amount: 1n,
    timestamp: 0,
    ...overrides,
  };
}

function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    at: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ReceiptMemoryCache monotonic TTL", () => {
  test("an expired-but-unread receipt never revives after a clock rollback", () => {
    const time = fakeClock(1_000);
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    cache.set("r", receipt()); // expiresAt = 1100
    // A long-lived entry lets the cache observe 1200 via get() without
    // triggering set()'s sweep, which would delete "r" and hide the bug.
    cache.set("observer", receipt({ receiptId: "observer" }), 1_000_000);

    // TTL elapsed for "r", and no set() called, so no eager delete happened.
    time.at(1_200);
    expect(cache.get("observer")?.receiptId).toBe("observer");
    // NTP step / VM migration moves the clock back before "r"'s expiresAt.
    time.at(1_050);

    expect(cache.has("r")).toBe(false);
    expect(cache.get("r")).toBeNull();
  });

  test("TTL still expires normally with a forward-only clock", () => {
    const time = fakeClock();
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    cache.set("r", receipt());

    time.at(99);
    expect(cache.has("r")).toBe(true);
    time.at(100);
    expect(cache.has("r")).toBe(false);
  });

  test("repeated rollback oscillations cannot extend a lifetime", () => {
    const time = fakeClock(1_000);
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    cache.set("r", receipt());
    cache.set("observer", receipt({ receiptId: "observer" }), 1_000_000);

    for (let i = 0; i < 5; i++) {
      const peak = 1_200 + i;
      time.at(peak);
      // Observe the peak through a live entry; calling set() here would sweep
      // "r" first and make the test pass for the wrong reason.
      expect(cache.get("observer")?.receiptId).toBe("observer");
      time.at(1_050 + i);
      expect(cache.has("r")).toBe(false);
    }
  });

  test("stale entries are reclaimed on set() even after the clock moves back", () => {
    const time = fakeClock();
    const cache = new ReceiptMemoryCache(100, 2, time.clock);
    cache.set("a", receipt({ receiptId: "a" }));
    cache.set("b", receipt({ receiptId: "b" }));

    time.at(1_000);
    expect(cache.has("a")).toBe(false); // observe that the TTL has elapsed
    time.at(0);
    cache.set("c", receipt({ receiptId: "c" }));

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")?.receiptId).toBe("c");
  });

  test("re-setting the same id after rollback creates a fresh unexpired entry", () => {
    const time = fakeClock();
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    cache.set("r", receipt());

    time.at(1_000);
    expect(cache.has("r")).toBe(false); // the old entry is observed as expired
    time.at(0);
    cache.set("r", receipt({ payer: "fresh" }));

    // Clamped time is 1000, so the replacement expires at 1100.
    time.at(1_050);
    expect(cache.get("r")?.payer).toBe("fresh");
    time.at(1_100);
    expect(cache.get("r")).toBeNull();
  });

  test("a wall-clock change cannot alter the lifetime of a default-clock entry", () => {
    const realNow = Date.now;
    const cache = new ReceiptMemoryCache(100, 10);
    try {
      cache.set("r", receipt());
      Date.now = () => realNow() + 10_000_000;
      expect(cache.get("r")?.receiptId).toBe("r");
      Date.now = () => realNow() - 10_000_000;
      expect(cache.get("r")?.receiptId).toBe("r");
    } finally {
      Date.now = realNow;
    }
  });

  test("the caller-supplied timestamp and amount are preserved unchanged", () => {
    const time = fakeClock(50);
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    const original = receipt({ timestamp: 17, amount: "9007199254740993" });
    cache.set("r", original);
    const stored = cache.get("r")!;

    expect(stored.timestamp).toBe(17);
    expect(stored.amount).toBe("9007199254740993");
    expect(stored.payer).toBe("0xabc");
  });

  test("returned receipts stay detached from stored state", () => {
    const time = fakeClock();
    const cache = new ReceiptMemoryCache(100, 10, time.clock);
    cache.set("r", receipt());

    const first = cache.get("r")!;
    first.payer = "mutated";
    expect(cache.get("r")?.payer).toBe("0xabc");
  });

  test("a non-function clock is rejected at construction", () => {
    expect(() => new ReceiptMemoryCache(100, 10, 1 as never)).toThrow(
      "Invalid cache limits",
    );
  });

  test("a clock that reports a non-finite or negative time fails closed", () => {
    let calls = 0;
    const broken = new ReceiptMemoryCache(100, 10, () =>
      calls++ === 0 ? 0 : Number.NaN,
    );
    broken.set("r", receipt());
    expect(() => broken.get("r")).toThrow("Invalid monotonic clock");

    const negative = new ReceiptMemoryCache(100, 10, () => -1);
    expect(() => negative.set("r", receipt())).toThrow(
      "Invalid monotonic clock",
    );
  });

  test("existing constructor validation is unchanged", () => {
    expect(() => new ReceiptMemoryCache(0)).toThrow("Invalid cache limits");
    expect(() => new ReceiptMemoryCache(1, 0)).toThrow("Invalid cache limits");
  });
});
