export interface RateLimitBackend {
  get(key: string): Promise<number | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
}

export class EdgeRateThrottler {
  private backend: RateLimitBackend;
  private maxRequests: number;
  private windowSeconds: number;

  constructor(backend: RateLimitBackend, maxRequests = 60, windowSeconds = 60) {
    this.backend = backend;
    this.maxRequests = maxRequests;
    this.windowSeconds = windowSeconds;
  }

  public async isAllowed(clientId: string): Promise<{ allowed: boolean; remaining: number }> {
    const key = `ratelimit:${clientId}`;
    const count = await this.backend.increment(key, this.windowSeconds);
    const allowed = count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - count),
    };
  }
}
