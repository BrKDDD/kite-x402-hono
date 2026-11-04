/**
 * Tiered Fee Scheduler and Volume Discount Engine for x402 payment wrappers.
 * Calculates dynamic fee adjustments and discounts based on caller historical volume or tier status.
 */

export interface FeeTier {
  name: string;
  minCumulativeVolumeAtomic: bigint;
  discountBps: number; // Basis points (e.g., 500 = 5%, 2000 = 20%)
}

export interface ClientVolumeRecord {
  clientAddress: string;
  cumulativeVolumeAtomic: bigint;
  txCount: number;
  lastUpdatedMs: number;
}

export interface TierEvaluation {
  clientAddress: string;
  tierName: string;
  baseAmountAtomic: bigint;
  discountBps: number;
  discountAtomic: bigint;
  finalAmountAtomic: bigint;
  cumulativeVolumeAtomic: bigint;
}

export interface TieredFeeSchedulerOptions {
  tiers?: FeeTier[];
  epochTtlMs?: number; // Volume reset period (default: 30 days)
}

export const DEFAULT_FEE_TIERS: FeeTier[] = [
  { name: "Standard", minCumulativeVolumeAtomic: 0n, discountBps: 0 },
  { name: "Bronze", minCumulativeVolumeAtomic: 10_000_000n, discountBps: 500 }, // $10 -> 5% off
  { name: "Silver", minCumulativeVolumeAtomic: 50_000_000n, discountBps: 1000 }, // $50 -> 10% off
  { name: "Gold", minCumulativeVolumeAtomic: 200_000_000n, discountBps: 1500 }, // $200 -> 15% off
  { name: "VIP", minCumulativeVolumeAtomic: 1_000_000_000n, discountBps: 2500 }, // $1000 -> 25% off
];

export class TieredFeeScheduler {
  private tiers: FeeTier[];
  private epochTtlMs: number;
  private clientVolumes: Map<string, ClientVolumeRecord> = new Map();

  constructor(options: TieredFeeSchedulerOptions = {}) {
    this.epochTtlMs = options.epochTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    const unsortedTiers = options.tiers ?? DEFAULT_FEE_TIERS;
    // Sort descending by minCumulativeVolumeAtomic for waterfall evaluation
    this.tiers = [...unsortedTiers].sort((a, b) =>
      b.minCumulativeVolumeAtomic > a.minCumulativeVolumeAtomic ? 1 : -1,
    );
  }

  /**
   * Records a settled payment for a client.
   */
  public recordPayment(
    clientAddress: string,
    settledAmountAtomic: bigint,
  ): ClientVolumeRecord {
    const key = clientAddress.toLowerCase();
    const now = Date.now();
    let record = this.clientVolumes.get(key);

    if (!record || now - record.lastUpdatedMs > this.epochTtlMs) {
      record = {
        clientAddress: key,
        cumulativeVolumeAtomic: settledAmountAtomic,
        txCount: 1,
        lastUpdatedMs: now,
      };
    } else {
      record.cumulativeVolumeAtomic += settledAmountAtomic;
      record.txCount += 1;
      record.lastUpdatedMs = now;
    }

    this.clientVolumes.set(key, record);
    return record;
  }

  /**
   * Evaluates the active tier and computes the discounted payment price.
   */
  public calculateFee(
    clientAddress: string,
    baseAmountAtomic: bigint,
  ): TierEvaluation {
    const key = clientAddress.toLowerCase();
    const now = Date.now();
    const record = this.clientVolumes.get(key);

    const activeVolume =
      record && now - record.lastUpdatedMs <= this.epochTtlMs
        ? record.cumulativeVolumeAtomic
        : 0n;

    // Find the matching tier
    let activeTier: FeeTier = this.tiers[this.tiers.length - 1] ?? {
      name: "Standard",
      minCumulativeVolumeAtomic: 0n,
      discountBps: 0,
    };
    for (const tier of this.tiers) {
      if (activeVolume >= tier.minCumulativeVolumeAtomic) {
        activeTier = tier;
        break;
      }
    }

    const discountAtomic =
      (baseAmountAtomic * BigInt(activeTier.discountBps)) / 10000n;
    const finalAmountAtomic = baseAmountAtomic - discountAtomic;

    return {
      clientAddress: key,
      tierName: activeTier.name,
      baseAmountAtomic,
      discountBps: activeTier.discountBps,
      discountAtomic,
      finalAmountAtomic,
      cumulativeVolumeAtomic: activeVolume,
    };
  }

  /**
   * Retrieves client record.
   */
  public getClientRecord(
    clientAddress: string,
  ): ClientVolumeRecord | undefined {
    return this.clientVolumes.get(clientAddress.toLowerCase());
  }

  /**
   * Resets all volume records.
   */
  public clear(): void {
    this.clientVolumes.clear();
  }
}
