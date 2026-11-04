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
    if (
      !Number.isSafeInteger(windowSizeMs) ||
      windowSizeMs < 1 ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1
    )
      throw new Error("Invalid window limits");
    this.windowSizeMs = windowSizeMs;
    this.maxRequests = maxRequests;
  }

  public check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowSizeMs;
    for (const [id, times] of this.windows)
      if ((times.at(-1) ?? 0) <= cutoff) this.windows.delete(id);
    if (!this.windows.has(key) && this.windows.size >= 10000)
      return {
        allowed: false,
        remaining: 0,
        resetSeconds: Math.ceil(this.windowSizeMs / 1000),
      };

    let timestamps = this.windows.get(key) || [];
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const resetSeconds = Math.ceil(
        (oldest! + this.windowSizeMs - now) / 1000,
      );
      return {
        allowed: false,
        remaining: 0,
        resetSeconds: Math.max(1, resetSeconds),
      };
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
