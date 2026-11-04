/**
 * In-memory settlement reconciler and receipt store for x402 payment services.
 * Tracks confirmed facilitator settlement transaction hashes, amounts, and
 * payer addresses for post-payment audits, telemetry, and reconciliation.
 */

export interface SettlementReceipt {
  txHash: string;
  payer: string;
  payTo: string;
  amount: bigint | number | string;
  network: string;
  timestamp: number;
  success: boolean;
  errorReason?: string;
}

export interface ReconcilerSummary {
  totalSettledAmount: bigint;
  successfulSettlements: number;
  failedSettlements: number;
  uniquePayersCount: number;
}

export interface SettlementQuery {
  payer?: string;
  success?: boolean;
  limit?: number;
}

export class SettlementReconciler {
  private receiptsByTx: Map<string, SettlementReceipt> = new Map();
  private receiptsByPayer: Map<string, SettlementReceipt[]> = new Map();
  private orderedTxHashes: string[] = [];
  private readonly maxCapacity: number;

  constructor(maxCapacity: number = 5_000) {
    this.maxCapacity = Math.max(100, maxCapacity);
  }

  record(receipt: SettlementReceipt): void {
    if (!receipt.txHash) {
      throw new Error("Missing transaction hash in settlement receipt");
    }

    const txKey = receipt.txHash.toLowerCase();
    const payerKey = receipt.payer.toLowerCase();

    // Capacity eviction (FIFO)
    if (this.orderedTxHashes.length >= this.maxCapacity) {
      const oldestTx = this.orderedTxHashes.shift();
      if (oldestTx) {
        const evicted = this.receiptsByTx.get(oldestTx);
        this.receiptsByTx.delete(oldestTx);
        if (evicted) {
          const payerList = this.receiptsByPayer.get(
            evicted.payer.toLowerCase(),
          );
          if (payerList) {
            const idx = payerList.findIndex(
              (r) => r.txHash.toLowerCase() === oldestTx,
            );
            if (idx !== -1) payerList.splice(idx, 1);
          }
        }
      }
    }

    this.receiptsByTx.set(txKey, receipt);
    this.orderedTxHashes.push(txKey);

    const payerList = this.receiptsByPayer.get(payerKey) ?? [];
    payerList.push(receipt);
    this.receiptsByPayer.set(payerKey, payerList);
  }

  getByTxHash(txHash: string): SettlementReceipt | undefined {
    return this.receiptsByTx.get(txHash.toLowerCase());
  }

  getByPayer(payer: string): SettlementReceipt[] {
    return [...(this.receiptsByPayer.get(payer.toLowerCase()) ?? [])];
  }

  query(filter: SettlementQuery = {}): SettlementReceipt[] {
    let matches: SettlementReceipt[];

    if (filter.payer) {
      matches = this.getByPayer(filter.payer);
    } else {
      matches = Array.from(this.receiptsByTx.values());
    }

    if (filter.success !== undefined) {
      matches = matches.filter((r) => r.success === filter.success);
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      matches = matches.slice(0, filter.limit);
    }

    return matches;
  }

  getSummary(): ReconcilerSummary {
    let total = 0n;
    let successful = 0;
    let failed = 0;

    for (const receipt of this.receiptsByTx.values()) {
      if (receipt.success) {
        successful++;
        try {
          total += BigInt(receipt.amount);
        } catch {
          // ignore parsing error for non-standard amount
        }
      } else {
        failed++;
      }
    }

    return {
      totalSettledAmount: total,
      successfulSettlements: successful,
      failedSettlements: failed,
      uniquePayersCount: this.receiptsByPayer.size,
    };
  }

  size(): number {
    return this.receiptsByTx.size;
  }

  clear(): void {
    this.receiptsByTx.clear();
    this.receiptsByPayer.clear();
    this.orderedTxHashes = [];
  }
}
