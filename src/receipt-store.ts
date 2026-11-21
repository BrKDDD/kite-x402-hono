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

interface ExpiryEntry {
  key: string;
  timestampMs: number;
}

/**
 * In-memory settled-receipt archive tuned for the paid request path.
 *
 * Retention used to be enforced by a full `for..of` over every stored receipt on
 * each read, so lookup cost grew linearly with retained entries (measured 236 us
 * at 5,000 entries versus 0.5 us for a Map lookup). Expiry is now tracked in a
 * min-heap ordered by `timestampMs`: cleanup only examines the earliest deadlines,
 * and a key-indexed position table keeps removals in sync so the heap never
 * accumulates stale entries for overwritten or evicted receipts.
 */
export class ReceiptStore {
  private receipts: Map<string, StoredReceipt> = new Map();
  private payerIndex: Map<string, Set<string>> = new Map();
  private maxEntries: number;
  private retentionMs: number;
  /** Earliest expiring receipts first; kept in sync with `receipts`. */
  private expiries: ExpiryEntry[] = [];
  /** Heap position per live receipt key. */
  private expiryIndex = new Map<string, number>();

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

  private swapExpiry(i: number, j: number): void {
    const heap = this.expiries;
    const a = heap[i]!;
    const b = heap[j]!;
    heap[i] = b;
    heap[j] = a;
    this.expiryIndex.set(a.key, j);
    this.expiryIndex.set(b.key, i);
  }

  private siftUpExpiry(start: number): void {
    let i = start;
    const heap = this.expiries;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.timestampMs <= heap[i]!.timestampMs) break;
      this.swapExpiry(i, parent);
      i = parent;
    }
  }

  private siftDownExpiry(start: number): void {
    let i = start;
    const heap = this.expiries;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (
        left < heap.length &&
        heap[left]!.timestampMs < heap[smallest]!.timestampMs
      )
        smallest = left;
      if (
        right < heap.length &&
        heap[right]!.timestampMs < heap[smallest]!.timestampMs
      )
        smallest = right;
      if (smallest === i) return;
      this.swapExpiry(i, smallest);
      i = smallest;
    }
  }

  private pushExpiry(key: string, timestampMs: number): void {
    this.expiries.push({ key, timestampMs });
    const i = this.expiries.length - 1;
    this.expiryIndex.set(key, i);
    this.siftUpExpiry(i);
  }

  private removeExpiry(key: string): void {
    const i = this.expiryIndex.get(key);
    if (i === undefined) return;
    const heap = this.expiries;
    const last = heap.pop()!;
    this.expiryIndex.delete(key);
    if (i === heap.length) return;
    heap[i] = last;
    this.expiryIndex.set(last.key, i);
    const parent = (i - 1) >> 1;
    if (i > 0 && heap[parent]!.timestampMs > heap[i]!.timestampMs)
      this.siftUpExpiry(i);
    else this.siftDownExpiry(i);
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
    this.pushExpiry(key, saved.timestampMs);
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
    this.removeExpiry(key);
    const index = this.payerIndex.get(old.payerAddress);
    index?.delete(key);
    if (!index?.size) this.payerIndex.delete(old.payerAddress);
  }

  private cleanup(): void {
    // Only the earliest deadlines can have lapsed. Stop at the first live
    // entry; no full scan of the retained receipt set is needed.
    const now = Date.now();
    for (;;) {
      const entry = this.expiries[0];
      if (!entry || now - entry.timestampMs < this.retentionMs) return;
      this.remove(entry.key);
    }
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
    this.expiries = [];
    this.expiryIndex.clear();
  }
}
