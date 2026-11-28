import { expect, test } from "bun:test";
import { TieredFeeScheduler } from "../src/tiered-fee-scheduler.js";
const invalid = [0, 1, "1", null, undefined, { valueOf: () => 1n }];

test("runtime tier thresholds must be bigint values", () => {
  for (const value of invalid) {
    expect(
      () =>
        new TieredFeeScheduler({
          tiers: [
            {
              name: "tier",
              discountBps: 100,
              minCumulativeVolumeAtomic: value as unknown as bigint,
            },
          ],
        }),
    ).toThrow("Invalid fee tier");
  }
});

test("invalid first payments cannot create a poisoned volume record", () => {
  for (const value of invalid) {
    const scheduler = new TieredFeeScheduler();
    expect(() =>
      scheduler.recordPayment("alice", value as unknown as bigint),
    ).toThrow("bigint");
    expect(scheduler.getClientRecord("alice")).toBeUndefined();
    expect(scheduler.recordPayment("alice", 1n).cumulativeVolumeAtomic).toBe(
      1n,
    );
  }
});

test("invalid subsequent payments preserve the previous amount and transaction count", () => {
  for (const value of invalid) {
    const scheduler = new TieredFeeScheduler();
    const before = scheduler.recordPayment("alice", 7n);
    expect(() =>
      scheduler.recordPayment("alice", value as unknown as bigint),
    ).toThrow("bigint");
    expect(scheduler.getClientRecord("alice")).toEqual(before);
    expect(scheduler.recordPayment("alice", 2n).cumulativeVolumeAtomic).toBe(
      9n,
    );
  }
});

test("fee calculation rejects coerced amounts at the public boundary", () => {
  const scheduler = new TieredFeeScheduler();
  for (const value of invalid)
    expect(() =>
      scheduler.calculateFee("alice", value as unknown as bigint),
    ).toThrow("bigint");
});

test("zero and large bigint values retain exact fee arithmetic", () => {
  const scheduler = new TieredFeeScheduler({
    tiers: [
      { name: "custom", discountBps: 500, minCumulativeVolumeAtomic: 0n },
    ],
  });
  const amount = (1n << 180n) + 123n;
  scheduler.recordPayment("alice", amount);
  expect(scheduler.recordPayment("alice", 0n).cumulativeVolumeAtomic).toBe(
    amount,
  );
  const fee = scheduler.calculateFee("alice", amount);
  expect(fee.discountAtomic).toBe((amount * 500n) / 10000n);
  expect(fee.finalAmountAtomic).toBe(amount - fee.discountAtomic);
});

test("negative bigint values retain existing rejection behavior", () => {
  const scheduler = new TieredFeeScheduler();
  expect(() => scheduler.recordPayment("alice", -1n)).toThrow("Negative");
  expect(() => scheduler.calculateFee("alice", -1n)).toThrow("Negative");
});

test("tier validation and evaluation retain the same bigint threshold snapshot", () => {
  let reads = 0;
  const scheduler = new TieredFeeScheduler({
    tiers: [
      {
        name: "custom",
        discountBps: 500,
        get minCumulativeVolumeAtomic() {
          return (++reads <= 2 ? 1n : 99) as bigint;
        },
      },
    ],
  });
  scheduler.recordPayment("alice", 1n);
  expect(reads).toBe(1);
  expect(scheduler.calculateFee("alice", 100n).tierName).toBe("custom");
});
