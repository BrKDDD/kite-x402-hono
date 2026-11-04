export interface RateLimitBackend {
  get(key: string): Promise<number | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
}

export class EdgeRateThrottler {
  private backend: RateLimitBackend;
  private maxRequests: number;
  private windowSeconds: number;

  constructor(backend: RateLimitBackend, maxRequests = 60, windowSeconds = 60) {
    if (
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1
    )
      throw new Error("Invalid edge limits");
    this.backend = backend;
    this.maxRequests = maxRequests;
    this.windowSeconds = windowSeconds;
  }

  public async isAllowed(
    clientId: string,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const window = Math.floor(Date.now() / (this.windowSeconds * 1000));
    const key = ["ratelimit", this.windowSeconds, window, clientId].join(":");
    const count = await this.backend.increment(key, this.windowSeconds);
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("Backend must atomically return a positive counter");
    const allowed = count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - count),
    };
  }
}
