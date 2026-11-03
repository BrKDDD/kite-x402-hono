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
    return entry;
  }

  public set(paymentKey: string, payerAddress: string, scheme = 'x402'): void {
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
