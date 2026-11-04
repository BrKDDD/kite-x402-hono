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
    this.retentionMs = config.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isFinite(this.retentionMs) ||
      this.retentionMs <= 0
    )
      throw new Error("Invalid receipt limits"); // 7 days
  }

  /**
   * Saves a settled payment receipt.
   */
  public saveReceipt(receipt: StoredReceipt): void {
    this.cleanup();
    const key = receipt.txHash.toLowerCase();
    this.remove(key);
    const saved = {
      ...receipt,
      txHash: key,
      payerAddress: receipt.payerAddress.toLowerCase(),
    };
    this.receipts.set(key, saved);
    const index = this.payerIndex.get(saved.payerAddress) ?? new Set<string>();
    index.add(key);
    this.payerIndex.set(saved.payerAddress, index);
    while (this.receipts.size > this.maxEntries)
      this.remove(this.receipts.keys().next().value!);
  }

  private remove(key: string): void {
    const old = this.receipts.get(key);
    if (!old) return;
    this.receipts.delete(key);
    const index = this.payerIndex.get(old.payerAddress);
    index?.delete(key);
    if (!index?.size) this.payerIndex.delete(old.payerAddress);
  }
  private cleanup(): void {
    for (const [key, receipt] of this.receipts)
      if (Date.now() - receipt.timestampMs >= this.retentionMs)
        this.remove(key);
  }

  /**
   * Retrieves receipt by on-chain transaction hash.
   */
  public getByTxHash(txHash: string): StoredReceipt | undefined {
    this.cleanup();
    const receipt = this.receipts.get(txHash.toLowerCase());
    return receipt ? { ...receipt } : undefined;
  }

  /**
   * Retrieves all receipts associated with a payer address.
   */
  public getByPayer(payerAddress: string): StoredReceipt[] {
    this.cleanup();
    const txHashes = this.payerIndex.get(payerAddress.toLowerCase());
    if (!txHashes) return [];

    return Array.from(txHashes)
      .map((hash) => this.receipts.get(hash)!)
      .filter(Boolean)
      .map((r) => ({ ...r }))
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
    this.cleanup();
    return this.receipts.size;
  }

  public clear(): void {
    this.receipts.clear();
    this.payerIndex.clear();
  }
}
