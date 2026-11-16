export interface CachedReceipt {
  receiptId: string;
  payer: string;
  /** Nonnegative atomic units; use bigint/string above the safe integer range. */
  amount: bigint | string | number;
  timestamp: number;
}

/** Local LRU storage of caller-verified receipts; not payment verification or durable replay protection. */
export class ReceiptMemoryCache {
  private cache = new Map<string, { data: CachedReceipt; expiresAt: number }>();
  constructor(
    private readonly defaultTtlMs = 300000,
    private readonly maxCapacity = 1000,
  ) {
    if (
      !Number.isSafeInteger(defaultTtlMs) ||
      defaultTtlMs < 1 ||
      !Number.isSafeInteger(maxCapacity) ||
      maxCapacity < 1
    )
      throw new Error("Invalid cache limits");
  }
  public set(
    receiptId: string,
    data: CachedReceipt,
    ttlMs = this.defaultTtlMs,
  ): void {
    const now = Date.now();
    if (
      !receiptId ||
      receiptId.length > 512 ||
      data.receiptId !== receiptId ||
      !data.payer ||
      data.payer.length > 512 ||
      !Number.isSafeInteger(data.timestamp) ||
      data.timestamp < 0 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      !Number.isSafeInteger(now + ttlMs) ||
      !["bigint", "number", "string"].includes(typeof data.amount) ||
      (typeof data.amount === "number" && !Number.isSafeInteger(data.amount)) ||
      (typeof data.amount === "string" &&
        (!/^\d+$/.test(data.amount) || data.amount.length > 256)) ||
      BigInt(data.amount) < 0n ||
      BigInt(data.amount) >= 1n << 256n
    )
      throw new Error("Invalid receipt or TTL");
    const copy: CachedReceipt = {
      receiptId,
      payer: data.payer,
      amount: data.amount,
      timestamp: data.timestamp,
    };
    for (const [key, entry] of this.cache)
      if (entry.expiresAt <= now) this.cache.delete(key);
    this.cache.delete(receiptId);
    if (this.cache.size >= this.maxCapacity)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(receiptId, { data: copy, expiresAt: now + ttlMs });
  }
  public get(receiptId: string): CachedReceipt | null {
    const entry = this.cache.get(receiptId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(receiptId);
      return null;
    }
    this.cache.delete(receiptId);
    this.cache.set(receiptId, entry);
    return { ...entry.data };
  }
  public has(receiptId: string): boolean {
    return this.get(receiptId) !== null;
  }
}
export default ReceiptMemoryCache;
