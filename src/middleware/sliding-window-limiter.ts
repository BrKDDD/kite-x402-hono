export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export class SlidingWindowLimiter {
  private windows = new Map<string, number[]>();
  private readonly windowSizeMs: number;
  private readonly maxRequests: number;

  constructor(windowSizeMs = 60000, maxRequests = 120) {
    this.windowSizeMs = windowSizeMs;
    this.maxRequests = maxRequests;
  }

  public check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowSizeMs;

    let timestamps = this.windows.get(key) || [];
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const resetSeconds = Math.ceil((oldest + this.windowSizeMs - now) / 1000);
      return { allowed: false, remaining: 0, resetSeconds: Math.max(1, resetSeconds) };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.maxRequests - timestamps.length,
      resetSeconds: Math.ceil(this.windowSizeMs / 1000),
    };
  }
}
