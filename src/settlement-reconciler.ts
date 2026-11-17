/**
 * In-memory settlement reconciler and receipt store for x402 payment services.
 * Tracks confirmed facilitator settlement transaction hashes, amounts, and
 * payer addresses for post-payment audits, telemetry, and reconciliation.
 */

import { tryParseAtomicAmount } from "./amount.js";

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

/**
 * A receipt that has been accepted by the reconciler.
 *
 * `amountAtomic` is the parsed form of `amount`, computed once on entry. It is
 * always a non-negative integer below 2^256, which is what makes aggregation
 * total: no recorded settlement can be skipped during summation.
 */
export interface StoredSettlementReceipt extends SettlementReceipt {
  readonly amountAtomic: bigint;
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
  private receiptsByTx: Map<string, StoredSettlementReceipt> = new Map();
  private receiptsByPayer: Map<string, StoredSettlementReceipt[]> = new Map();
  private orderedTxHashes: string[] = [];
  private readonly maxCapacity: number;
  private network: string | undefined;

  constructor(maxCapacity: number = 5_000, network?: string) {
    if (!Number.isSafeInteger(maxCapacity) || maxCapacity < 1)
      throw new Error("Invalid receipt capacity");
    if (network !== undefined && (!network || network.trim() !== network))
      throw new Error("Invalid settlement network");
    this.maxCapacity = maxCapacity;
    this.network = network;
  }

  record(receipt: SettlementReceipt): void {
    if (!receipt.txHash) {
      throw new Error("Missing transaction hash in settlement receipt");
    }

    if (!receipt.network || receipt.network.trim() !== receipt.network)
      throw new Error("Invalid settlement network");
    if (this.network !== undefined && receipt.network !== this.network)
      throw new Error("Settlement network does not match this reconciler");

    // Reject before the duplicate check so an invalid amount is always reported,
    // and parse once here so aggregation never has to interpret it again.
    const amountAtomic = tryParseAtomicAmount(receipt.amount);
    if (amountAtomic === null) throw new Error("Invalid settlement amount");

    const txKey = receipt.txHash.toLowerCase();
    const payerKey = receipt.payer.toLowerCase();
    if (this.receiptsByTx.has(txKey)) return;
    const stored: StoredSettlementReceipt = { ...receipt, amountAtomic };

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
            if (!payerList.length)
              this.receiptsByPayer.delete(evicted.payer.toLowerCase());
          }
        }
      }
    }

    this.network ??= stored.network;
    this.receiptsByTx.set(txKey, stored);
    this.orderedTxHashes.push(txKey);

    const payerList = this.receiptsByPayer.get(payerKey) ?? [];
    payerList.push(stored);
    this.receiptsByPayer.set(payerKey, payerList);
  }

  getByTxHash(txHash: string): StoredSettlementReceipt | undefined {
    const found = this.receiptsByTx.get(txHash.toLowerCase());
    return found ? { ...found } : undefined;
  }

  getByPayer(payer: string): StoredSettlementReceipt[] {
    return (this.receiptsByPayer.get(payer.toLowerCase()) ?? []).map((r) => ({
      ...r,
    }));
  }

  query(filter: SettlementQuery = {}): StoredSettlementReceipt[] {
    let matches: StoredSettlementReceipt[];

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

    return matches.map((r) => ({ ...r }));
  }

  getSummary(): ReconcilerSummary {
    let total = 0n;
    let successful = 0;
    let failed = 0;

    for (const receipt of this.receiptsByTx.values()) {
      if (receipt.success) {
        successful++;
        // Already parsed and range-checked on entry, so every successful
        // settlement contributes: the total cannot be silently under-reported.
        total += receipt.amountAtomic;
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

  /** The network binding survives clear; use a new instance for another network. */
  clear(): void {
    this.receiptsByTx.clear();
    this.receiptsByPayer.clear();
    this.orderedTxHashes = [];
  }
}
