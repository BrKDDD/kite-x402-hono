export interface CachedAuthEntry {
  payerAddress: string;
  scheme: string;
  verifiedAt: number;
  expiresAt: number;
}

export class PaymentAuthCache {
  private cache = new Map<string, CachedAuthEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 60000, maxEntries = 5000) {
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1
    )
      throw new Error("Invalid cache limits");
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  public get(paymentKey: string): CachedAuthEntry | null {
    const entry = this.cache.get(paymentKey);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(paymentKey);
      return null;
    }
    this.cache.delete(paymentKey);
    this.cache.set(paymentKey, entry);
    return { ...entry };
  }

  public set(paymentKey: string, payerAddress: string, scheme = "x402"): void {
    this.cache.delete(paymentKey);
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const now = Date.now();
    this.cache.set(paymentKey, {
      payerAddress,
      scheme,
      verifiedAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  public size(): number {
    return this.cache.size;
  }
}
