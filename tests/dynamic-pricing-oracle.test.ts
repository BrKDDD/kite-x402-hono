import { describe, it, expect } from "bun:test";
import { DynamicPricingOracle } from "../src/dynamic-pricing-oracle.js";

describe("DynamicPricingOracle", () => {
  it("evaluates standard baseline price when congestion is normal", () => {
    const oracle = new DynamicPricingOracle();
    const result = oracle.evaluatePrice(10_000_000n);

    expect(result.congestionLevel).toBe("NORMAL");
    expect(result.appliedMultiplierBps).toBe(10000);
    expect(result.finalAmountAtomic).toBe(10_000_000n);
    expect(result.surchargeAtomic).toBe(0n);
  });

  it("applies off-peak discount when metrics indicate low activity", () => {
    const oracle = new DynamicPricingOracle();
    oracle.updateCongestionMetrics(2, 8); // Low queue and low gas

    const result = oracle.evaluatePrice(10_000_000n);
    expect(result.congestionLevel).toBe("LOW");
    expect(result.appliedMultiplierBps).toBe(8500); // 15% discount
    expect(result.finalAmountAtomic).toBe(8_500_000n);
  });

  it("applies surge pricing and honors surcharge cap during extreme congestion", () => {
    const oracle = new DynamicPricingOracle({
      maxSurchargeAtomic: 5_000_000n, // $5 max surcharge cap
    });

    oracle.updateCongestionMetrics(800, 200); // Extreme congestion
    expect(oracle.getCongestionLevel()).toBe("EXTREME");

    // $10 base with 2.0x multiplier would normally add $10 surcharge, capped at $5
    const result = oracle.evaluatePrice(10_000_000n);
    expect(result.surchargeAtomic).toBe(5_000_000n);
    expect(result.finalAmountAtomic).toBe(15_000_000n);
  });

  it("allows manual override to take precedence", () => {
    const oracle = new DynamicPricingOracle();
    oracle.updateCongestionMetrics(1000, 300); // Extreme
    oracle.setOverride("LOW");

    const result = oracle.evaluatePrice(10_000_000n);
    expect(result.congestionLevel).toBe("LOW");
    expect(result.finalAmountAtomic).toBe(8_500_000n);
  });
});
