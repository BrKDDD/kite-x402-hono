/**
 * Settlement Receipt Archive and Payer Query Service for x402 payment wrappers.
 * Persists settled payment proofs and facilitates audit lookups by txHash or payer address.
 */

export interface StoredReceipt {
  txHash: string;
  requestId: string;
  payerAddress: string;
  recipientAddress: string;
  amountAtomic: bigint;
  network: string;
  timestampMs: number;
}

export interface ReceiptStoreConfig {
  maxEntries?: number;
  retentionMs?: number;
}

export class ReceiptStore {
  private receipts: Map<string, StoredReceipt> = new Map();
  private payerIndex: Map<string, Set<string>> = new Map();
  private maxEntries: number;
  private retentionMs: number;

  constructor(config: ReceiptStoreConfig = {}) {
    this.maxEntries = config.maxEntries ?? 5000;
    this.retentionMs = config.retentionMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  /**
   * Saves a settled payment receipt.
   */
  public saveReceipt(receipt: StoredReceipt): void {
    const payerKey = receipt.payerAddress.toLowerCase();
    this.receipts.set(receipt.txHash, {
      ...receipt,
      payerAddress: payerKey,
    });

    if (!this.payerIndex.has(payerKey)) {
      this.payerIndex.set(payerKey, new Set());
    }
    this.payerIndex.get(payerKey)!.add(receipt.txHash);

    // Evict oldest if exceeding capacity
    if (this.receipts.size > this.maxEntries) {
      const firstKey = this.receipts.keys().next().value;
      if (firstKey) {
        const removed = this.receipts.get(firstKey);
        if (removed) {
          this.payerIndex.get(removed.payerAddress)?.delete(firstKey);
        }
        this.receipts.delete(firstKey);
      }
    }
  }

  /**
   * Retrieves receipt by on-chain transaction hash.
   */
  public getByTxHash(txHash: string): StoredReceipt | undefined {
    return this.receipts.get(txHash);
  }

  /**
   * Retrieves all receipts associated with a payer address.
   */
  public getByPayer(payerAddress: string): StoredReceipt[] {
    const txHashes = this.payerIndex.get(payerAddress.toLowerCase());
    if (!txHashes) return [];

    return Array.from(txHashes)
      .map((hash) => this.receipts.get(hash)!)
      .filter(Boolean)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }

  /**
   * Calculates total volume settled by a payer.
   */
  public getPayerVolume(payerAddress: string): bigint {
    const list = this.getByPayer(payerAddress);
    return list.reduce((sum, r) => sum + r.amountAtomic, 0n);
  }

  public size(): number {
    return this.receipts.size;
  }

  public clear(): void {
    this.receipts.clear();
    this.payerIndex.clear();
  }
}
