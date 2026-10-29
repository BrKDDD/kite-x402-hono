/**
 * Dynamic Pricing and Congestion Oracle for x402 payment requirements.
 * Dynamically computes payment amounts based on network congestion, time-of-day multipliers,
 * and service load factors.
 */

export type CongestionLevel = "LOW" | "NORMAL" | "HIGH" | "EXTREME";

export interface CongestionMultiplierConfig {
  lowMultiplierBps: number; // e.g. 8500 = 0.85x (15% discount for off-peak)
  normalMultiplierBps: number; // 10000 = 1.0x
  highMultiplierBps: number; // 12500 = 1.25x (+25%)
  extremeMultiplierBps: number; // 20000 = 2.0x (+100%)
  maxSurchargeAtomic: bigint; // Maximum fee cap
}

export interface PricingEvaluation {
  baseAmountAtomic: bigint;
  congestionLevel: CongestionLevel;
  appliedMultiplierBps: number;
  surchargeAtomic: bigint;
  finalAmountAtomic: bigint;
  reason: string;
  evaluatedAt: number;
}

export const DEFAULT_MULTIPLIERS: CongestionMultiplierConfig = {
  lowMultiplierBps: 8500,
  normalMultiplierBps: 10000,
  highMultiplierBps: 12500,
  extremeMultiplierBps: 20000,
  maxSurchargeAtomic: 100_000_000n, // $100 cap
};

export class DynamicPricingOracle {
  private config: CongestionMultiplierConfig;
  private currentCongestion: CongestionLevel = "NORMAL";
  private manualOverride: CongestionLevel | null = null;

  constructor(config: Partial<CongestionMultiplierConfig> = {}) {
    this.config = { ...DEFAULT_MULTIPLIERS, ...config };
  }

  /**
   * Sets manual congestion override (e.g., during network outages or special events).
   */
  public setOverride(level: CongestionLevel | null): void {
    this.manualOverride = level;
  }

  /**
   * Updates congestion metric based on queue depth or average gas fee.
   */
  public updateCongestionMetrics(
    pendingQueueSize: number,
    avgGasGwei: number,
  ): CongestionLevel {
    if (pendingQueueSize > 500 || avgGasGwei > 150) {
      this.currentCongestion = "EXTREME";
    } else if (pendingQueueSize > 100 || avgGasGwei > 50) {
      this.currentCongestion = "HIGH";
    } else if (pendingQueueSize < 10 && avgGasGwei < 15) {
      this.currentCongestion = "LOW";
    } else {
      this.currentCongestion = "NORMAL";
    }
    return this.currentCongestion;
  }

  /**
   * Calculates the final dynamic payment required for a request.
   */
  public evaluatePrice(baseAmountAtomic: bigint): PricingEvaluation {
    const level = this.manualOverride ?? this.currentCongestion;
    let multiplierBps = this.config.normalMultiplierBps;

    switch (level) {
      case "LOW":
        multiplierBps = this.config.lowMultiplierBps;
        break;
      case "NORMAL":
        multiplierBps = this.config.normalMultiplierBps;
        break;
      case "HIGH":
        multiplierBps = this.config.highMultiplierBps;
        break;
      case "EXTREME":
        multiplierBps = this.config.extremeMultiplierBps;
        break;
    }

    const unscaled = (baseAmountAtomic * BigInt(multiplierBps)) / 10000n;
    let surcharge =
      unscaled > baseAmountAtomic ? unscaled - baseAmountAtomic : 0n;

    // Apply surcharge cap
    if (surcharge > this.config.maxSurchargeAtomic) {
      surcharge = this.config.maxSurchargeAtomic;
    }

    const finalAmountAtomic =
      unscaled > baseAmountAtomic ? baseAmountAtomic + surcharge : unscaled; // handles discounts when multiplier < 10000

    const reason =
      level === "LOW"
        ? "Off-peak incentive discount applied"
        : level === "HIGH" || level === "EXTREME"
          ? `Surge pricing active (${level} congestion)`
          : "Standard baseline pricing";

    return {
      baseAmountAtomic,
      congestionLevel: level,
      appliedMultiplierBps: multiplierBps,
      surchargeAtomic: surcharge,
      finalAmountAtomic,
      reason,
      evaluatedAt: Date.now(),
    };
  }

  public getCongestionLevel(): CongestionLevel {
    return this.manualOverride ?? this.currentCongestion;
  }
}
