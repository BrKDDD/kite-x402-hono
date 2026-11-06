import { expect, test } from "bun:test";
import { TieredFeeScheduler } from "../src/tiered-fee-scheduler.js";

test("returned payment and query records cannot change later fee decisions", () => {
  const scheduler = new TieredFeeScheduler();
  const written = scheduler.recordPayment("PAYER", 1n);
  written.cumulativeVolumeAtomic = 1_000_000_000n;
  written.txCount = 999;
  expect(scheduler.calculateFee("payer", 10000n).tierName).toBe("Standard");
  const read = scheduler.getClientRecord("payer")!;
  read.cumulativeVolumeAtomic = 1_000_000_000n;
  read.lastUpdatedMs = 0;
  expect(scheduler.getClientRecord("payer")).toMatchObject({
    cumulativeVolumeAtomic: 1n,
    txCount: 1,
  });
  expect(scheduler.calculateFee("payer", 10000n).finalAmountAtomic).toBe(
    10000n,
  );
  expect(scheduler.getClientRecord("missing")).toBeUndefined();
});

test("tier configuration is copied before callers can mutate it", () => {
  const tiers = [
    { name: "Paid", minCumulativeVolumeAtomic: 10n, discountBps: 500 },
  ];
  const scheduler = new TieredFeeScheduler({ tiers });
  tiers[0]!.minCumulativeVolumeAtomic = 0n;
  tiers[0]!.discountBps = 10000;
  tiers[0]!.name = "changed";
  expect(scheduler.calculateFee("payer", 10000n).finalAmountAtomic).toBe(
    10000n,
  );
  scheduler.recordPayment("payer", 10n);
  expect(scheduler.calculateFee("payer", 10000n)).toMatchObject({
    tierName: "Paid",
    finalAmountAtomic: 9500n,
  });
});
