import { describe, expect, test } from "bun:test";
import { PaymentNonceReplayGuard } from "../src/nonce-guard.js";

const payer = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
const nonce =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

describe("PaymentNonceReplayGuard sweep throttling", () => {
  test("counts no sweeps before the guard is used", () => {
    const guard = new PaymentNonceReplayGuard();
    expect(guard.sweepCount).toBe(0);
  });

  test("acquiring repeatedly inside one interval sweeps only once", () => {
    const guard = new PaymentNonceReplayGuard({
      consumedTtlMs: 600_000,
      sweepIntervalMs: 1_000,
    });
    const t0 = 1_000_000;
    for (let i = 0; i < 500; i++) guard.commit(payer, `0xn${i}`, t0);

    for (let i = 0; i < 500; i++) {
      expect(guard.acquire(payer, `0xa${i}`, t0 + i)).toBe(true);
    }

    // One sweep for 500 acquisitions, not 500 sweeps of a 500-entry map.
    expect(guard.sweepCount).toBe(1);
  });

  test("sweeps again once the interval has elapsed", () => {
    const guard = new PaymentNonceReplayGuard({
      consumedTtlMs: 600_000,
      sweepIntervalMs: 1_000,
    });
    const t0 = 1_000_000;
    guard.acquire(payer, "0xa", t0);
    guard.acquire(payer, "0xb", t0 + 999);
    expect(guard.sweepCount).toBe(1);

    guard.acquire(payer, "0xc", t0 + 1_000);
    expect(guard.sweepCount).toBe(2);
  });

  test("a lapsed nonce is rejected as expired even before any sweep", () => {
    const guard = new PaymentNonceReplayGuard({
      consumedTtlMs: 100,
      sweepIntervalMs: 60_000,
    });
    const t0 = 1_000_000;
    guard.commit(payer, nonce, t0);

    expect(guard.check(payer, nonce, t0 + 50)).toBe("CONSUMED");
    expect(guard.check(payer, nonce, t0 + 101)).toBe("AVAILABLE");
    // Decisions read the entry's own expiry, so throttling the sweep cannot
    // widen the replay window.
    expect(guard.acquire(payer, nonce, t0 + 101)).toBe(true);
    expect(guard.sweepCount).toBe(1);
  });

  test("reclaims lapsed entries instead of refusing at the cap", () => {
    const guard = new PaymentNonceReplayGuard({
      consumedTtlMs: 100,
      maxEntries: 2,
      sweepIntervalMs: 60_000,
    });
    const t0 = 1_000_000;
    // Warm the interval so the acquisition below cannot sweep on schedule.
    guard.acquire(payer, "0xwarm", t0);
    guard.release(payer, "0xwarm");
    guard.commit(payer, "0xn0", t0);
    guard.commit(payer, "0xn1", t0);

    // Both entries lapsed at t0 + 100 but are still tracked; the cap is reached
    // only by stale records, so the payment must be admitted.
    expect(guard.acquire(payer, "0xn2", t0 + 500)).toBe(true);
    expect(guard.sweepCount).toBe(1);
  });

  test("commit still records a settled nonce at the cap", () => {
    const guard = new PaymentNonceReplayGuard({
      consumedTtlMs: 100,
      maxEntries: 2,
      sweepIntervalMs: 60_000,
    });
    const t0 = 1_000_000;
    guard.acquire(payer, "0xwarm", t0);
    guard.release(payer, "0xwarm");
    guard.commit(payer, "0xn0", t0);
    guard.commit(payer, "0xn1", t0);

    guard.commit(payer, "0xn2", t0 + 500);

    // Dropping this record would report a settled nonce as AVAILABLE.
    expect(guard.check(payer, "0xn2", t0 + 500)).toBe("CONSUMED");
  });

  test("a zero interval sweeps on every acquisition", () => {
    const guard = new PaymentNonceReplayGuard({ sweepIntervalMs: 0 });
    guard.acquire(payer, "0xa", 1_000);
    guard.acquire(payer, "0xb", 1_000);
    guard.acquire(payer, "0xc", 1_000);
    expect(guard.sweepCount).toBe(3);
  });

  test("sweeps never reclaim an active lease", () => {
    const guard = new PaymentNonceReplayGuard({ sweepIntervalMs: 0 });
    const lease = guard.reserve(payer, nonce, 100);
    expect(lease).not.toBeNull();

    guard.acquire(payer, "0xother", 1_000_000);
    expect(guard.check(payer, nonce, 1_000_000)).toBe("IN_FLIGHT");

    lease!.commit(1_000_000);
    expect(guard.check(payer, nonce, 1_000_001)).toBe("CONSUMED");
  });

  test("rejects an invalid sweep interval", () => {
    expect(() => new PaymentNonceReplayGuard({ sweepIntervalMs: -1 })).toThrow(
      "Invalid nonce guard sweep interval",
    );
    expect(() => new PaymentNonceReplayGuard({ sweepIntervalMs: 1.5 })).toThrow(
      "Invalid nonce guard sweep interval",
    );
    expect(
      () => new PaymentNonceReplayGuard({ sweepIntervalMs: Number.NaN }),
    ).toThrow("Invalid nonce guard sweep interval");
  });
});
