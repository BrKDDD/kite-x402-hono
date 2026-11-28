import { describe, expect, test } from "bun:test";
import { SettlementReconciler } from "../src/settlement-reconciler.js";
import { ReceiptMemoryCache } from "../src/services/receiptMemoryCache.js";
import { tryParseAtomicAmount } from "../src/amount.js";

const UINT256_EXCLUSIVE = 1n << 256n;
const MAX_UINT256 = UINT256_EXCLUSIVE - 1n;

const payer = "0x1111111111111111111111111111111111111111";
const payTo = "0x2222222222222222222222222222222222222222";

function receipt(txHash: string, amount: bigint | number | string) {
  return {
    txHash,
    payer,
    payTo,
    amount,
    network: "kite-testnet",
    timestamp: 1_000,
    success: true,
  };
}

describe("tryParseAtomicAmount", () => {
  test("accepts bigint within the uint256 range", () => {
    expect(tryParseAtomicAmount(0n)).toBe(0n);
    expect(tryParseAtomicAmount(1_000_000n)).toBe(1_000_000n);
    expect(tryParseAtomicAmount(MAX_UINT256)).toBe(MAX_UINT256);
  });

  test("rejects a negative or out-of-range bigint", () => {
    expect(tryParseAtomicAmount(-1n)).toBeNull();
    expect(tryParseAtomicAmount(UINT256_EXCLUSIVE)).toBeNull();
  });

  test("accepts safe integers only", () => {
    expect(tryParseAtomicAmount(0)).toBe(0n);
    expect(tryParseAtomicAmount(1_000_000)).toBe(1_000_000n);
    expect(tryParseAtomicAmount(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );

    // Fractional numbers are the case that used to be dropped silently:
    // BigInt(0.05) throws, and the throw was swallowed during aggregation.
    expect(tryParseAtomicAmount(0.05)).toBeNull();
    expect(tryParseAtomicAmount(1.5)).toBeNull();
    expect(tryParseAtomicAmount(-1)).toBeNull();
    expect(tryParseAtomicAmount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(tryParseAtomicAmount(Number.NaN)).toBeNull();
    expect(tryParseAtomicAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(tryParseAtomicAmount(-0)).toBe(0n);
  });

  test("accepts decimal integer strings only", () => {
    expect(tryParseAtomicAmount("0")).toBe(0n);
    expect(tryParseAtomicAmount("1000")).toBe(1000n);
    expect(tryParseAtomicAmount("007")).toBe(7n);
    expect(tryParseAtomicAmount(MAX_UINT256.toString())).toBe(MAX_UINT256);

    expect(tryParseAtomicAmount("")).toBeNull();
    expect(tryParseAtomicAmount("1.5")).toBeNull();
    expect(tryParseAtomicAmount("1e6")).toBeNull();
    expect(tryParseAtomicAmount(" 1")).toBeNull();
    expect(tryParseAtomicAmount("1 ")).toBeNull();
    expect(tryParseAtomicAmount("-1")).toBeNull();
    expect(tryParseAtomicAmount("+1")).toBeNull();
    expect(tryParseAtomicAmount("0x10")).toBeNull();
    expect(tryParseAtomicAmount("1_000")).toBeNull();
  });

  test("rejects a decimal string beyond the uint256 range", () => {
    expect(tryParseAtomicAmount(UINT256_EXCLUSIVE.toString())).toBeNull();
    // 79 digits is already above 2^256, so the length bound cannot hide a
    // representable value.
    expect(tryParseAtomicAmount("1" + "0".repeat(78))).toBeNull();
  });

  test("bounds parsing work for a padded string", () => {
    // Leading zeros stay accepted up to the documented bound...
    expect(tryParseAtomicAmount("0".repeat(250) + "1000")).toBe(1000n);
    // ...and an input beyond it is rejected before BigInt sees it.
    expect(tryParseAtomicAmount("0".repeat(300) + "1000")).toBeNull();
  });

  test("rejects everything that is not a bigint, number or string", () => {
    for (const value of [null, undefined, true, {}, [], Symbol("x")]) {
      expect(tryParseAtomicAmount(value)).toBeNull();
    }
  });
});

describe("SettlementReconciler amount integrity", () => {
  test("rejects an amount that is not representable in atomic units", () => {
    const reconciler = new SettlementReconciler();
    // These were previously recorded as successful and then skipped during
    // aggregation, so a settled payment contributed nothing to the total.
    expect(() => reconciler.record(receipt("0xaa01", 0.05))).toThrow(
      "Invalid settlement amount",
    );
    expect(() => reconciler.record(receipt("0xaa02", "1.5"))).toThrow(
      "Invalid settlement amount",
    );
    expect(() => reconciler.record(receipt("0xaa03", -1n))).toThrow(
      "Invalid settlement amount",
    );
    expect(() => reconciler.record(receipt("0xaa04", 1n << 256n))).toThrow(
      "Invalid settlement amount",
    );
    expect(() =>
      reconciler.record(receipt("0xaa05", Number.MAX_SAFE_INTEGER + 1)),
    ).toThrow("Invalid settlement amount");
    expect(reconciler.size()).toBe(0);
  });

  test("rejects an invalid amount even for a duplicate transaction", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0xbb01", 1_000n));
    // Validation runs before the duplicate check, so a malformed retry is
    // reported rather than silently ignored.
    expect(() => reconciler.record(receipt("0xbb01", 0.05))).toThrow(
      "Invalid settlement amount",
    );
  });

  test("still deduplicates a repeated transaction hash", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0xcc01", 1_000n));
    reconciler.record(receipt("0xcc01", 1_000n));
    expect(reconciler.size()).toBe(1);
  });

  test("sums successful settlements across bigint, number and integer string", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0xdd01", 1_000_000n));
    reconciler.record(receipt("0xdd02", 2_500_000));
    reconciler.record(receipt("0xdd03", "4000000"));

    // All three inputs are valid atomic amounts. The regression this pins is
    // the rejection path above: an invalid successful receipt must never be
    // recorded and then skipped during summation.
    expect(reconciler.getSummary().totalSettledAmount).toBe(7_500_000n);
    expect(reconciler.getSummary().successfulSettlements).toBe(3);
  });

  test("excludes failed settlements from the total", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0xee01", 1_000n));
    reconciler.record({ ...receipt("0xee02", 500n), success: false });

    const summary = reconciler.getSummary();
    expect(summary.totalSettledAmount).toBe(1_000n);
    expect(summary.successfulSettlements).toBe(1);
    expect(summary.failedSettlements).toBe(1);
  });

  test("a failed receipt keeps its original amount even when it is unrepresentable", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record({
      ...receipt("0xee03", "not-an-atomic-amount"),
      success: false,
    });

    const summary = reconciler.getSummary();
    expect(summary.failedSettlements).toBe(1);
    expect(summary.successfulSettlements).toBe(0);
    expect(summary.totalSettledAmount).toBe(0n);

    const stored = reconciler.getByTxHash("0xee03");
    expect(stored?.amount).toBe("not-an-atomic-amount");
    expect(stored?.amountAtomic).toBe(0n);
  });

  test("keeps the reported amount representation unchanged", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0xff01", "1000"));

    const found = reconciler.getByTxHash("0xFF01");
    // Callers that print or hash the original value keep working...
    expect(found?.amount).toBe("1000");
    // ...and the parsed form is available without reinterpreting it.
    expect(found?.amountAtomic).toBe(1_000n);
  });

  test("exposes the parsed amount through payer queries and summaries", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt("0x1a01", 120n));
    reconciler.record(receipt("0x1a02", "80"));
    reconciler.record({
      ...receipt("0x1a03", 1_000n),
      payer: "0x3333333333333333333333333333333333333333",
    });

    const mine = reconciler.getByPayer(payer);
    expect(mine.map((r) => r.amountAtomic)).toEqual([120n, 80n]);
    expect(
      reconciler.query({ payer }).reduce((n, r) => n + r.amountAtomic, 0n),
    ).toBe(200n);
    expect(reconciler.getSummary().uniquePayersCount).toBe(2);
  });

  test("applies the same rule to the receipt cache", () => {
    const cache = new ReceiptMemoryCache();
    const base = { receiptId: "r1", payer, timestamp: 1 };

    expect(() => cache.set("r1", { ...base, amount: 1000n })).not.toThrow();
    expect(() => cache.set("r1", { ...base, amount: "1000" })).not.toThrow();
    expect(() => cache.set("r1", { ...base, amount: 1000 })).not.toThrow();

    for (const amount of [0.05, "1.5", -1n, 1n << 256n, ""]) {
      expect(() => cache.set("r1", { ...base, amount })).toThrow(
        "Invalid receipt or TTL",
      );
    }
  });
});
