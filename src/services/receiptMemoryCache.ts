export interface CachedReceipt {
  receiptId: string;
  payer: string;
  amount: number;
  timestamp: number;
}

export class ReceiptMemoryCache {
  private cache: Map<string, { data: CachedReceipt; expiresAt: number }>;
  private defaultTtlMs: number;
  private maxCapacity: number;

  constructor(defaultTtlMs: number = 300000, maxCapacity: number = 1000) {
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.maxCapacity = maxCapacity;
  }

  public set(receiptId: string, data: CachedReceipt, ttlMs?: number): void {
    if (this.cache.size >= this.maxCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    const expiresAt = Date.now() + (ttlMs || this.defaultTtlMs);
    this.cache.set(receiptId, { data, expiresAt });
  }

  public get(receiptId: string): CachedReceipt | null {
    const entry = this.cache.get(receiptId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(receiptId);
      return null;
    }
    return entry.data;
  }

  public has(receiptId: string): boolean {
    return this.get(receiptId) !== null;
  }
}

export default ReceiptMemoryCache;
