import { describe, it, expect } from "bun:test";
import {
  TieredFeeScheduler,
  DEFAULT_FEE_TIERS,
} from "../src/tiered-fee-scheduler.js";

describe("TieredFeeScheduler", () => {
  it("defaults new clients to Standard tier with zero discount", () => {
    const scheduler = new TieredFeeScheduler();
    const evalResult = scheduler.calculateFee("0xClientA", 1_000_000n);

    expect(evalResult.tierName).toBe("Standard");
    expect(evalResult.discountBps).toBe(0);
    expect(evalResult.discountAtomic).toBe(0n);
    expect(evalResult.finalAmountAtomic).toBe(1_000_000n);
  });

  it("advances client tier as payments accumulate", () => {
    const scheduler = new TieredFeeScheduler();

    // Record $15 payment (15,000,000 atomic units) -> qualifies for Bronze (>= $10)
    scheduler.recordPayment("0xClientA", 15_000_000n);

    let evalResult = scheduler.calculateFee("0xClientA", 10_000_000n);
    expect(evalResult.tierName).toBe("Bronze");
    expect(evalResult.discountBps).toBe(500); // 5%
    expect(evalResult.discountAtomic).toBe(500_000n);
    expect(evalResult.finalAmountAtomic).toBe(9_500_000n);

    // Record another $40 payment -> cumulative $55 -> qualifies for Silver (>= $50)
    scheduler.recordPayment("0xClientA", 40_000_000n);
    evalResult = scheduler.calculateFee("0xClientA", 10_000_000n);
    expect(evalResult.tierName).toBe("Silver");
    expect(evalResult.discountBps).toBe(1000); // 10%
    expect(evalResult.discountAtomic).toBe(1_000_000n);
    expect(evalResult.finalAmountAtomic).toBe(9_000_000n);
  });

  it("handles custom tier thresholds and epoch expiration", () => {
    const scheduler = new TieredFeeScheduler({
      tiers: [
        { name: "Normal", minCumulativeVolumeAtomic: 0n, discountBps: 0 },
        {
          name: "Partner",
          minCumulativeVolumeAtomic: 5_000_000n,
          discountBps: 2000,
        }, // 20%
      ],
      epochTtlMs: 10, // 10ms
    });

    scheduler.recordPayment("0xPartner1", 10_000_000n);
    let evalResult = scheduler.calculateFee("0xPartner1", 1_000_000n);
    expect(evalResult.tierName).toBe("Partner");
    expect(evalResult.discountBps).toBe(2000);

    // Simulate epoch expiration
    const record = scheduler.getClientRecord("0xPartner1");
    if (record) {
      record.lastUpdatedMs = Date.now() - 50; // Expired
    }

    evalResult = scheduler.calculateFee("0xPartner1", 1_000_000n);
    expect(evalResult.tierName).toBe("Normal");
    expect(evalResult.discountBps).toBe(0);
  });
});
