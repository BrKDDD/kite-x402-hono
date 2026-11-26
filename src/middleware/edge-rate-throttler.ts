export interface RateLimitBackend {
  get(key: string): Promise<number | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
}

export type EdgeClock = () => number;

/**
 * Fixed-window edge throttler that never grants a fresh quota on a backward
 * clock step.
 *
 * Invariants:
 * - each client's highest observed window is monotonic and never deleted. A
 *   rollback therefore reuses the already-spent window key.
 * - capacity is fail-closed: a new client is denied while the map is full.
 *   Evicting an incumbent would drop its high-water mark and reopen the exact
 *   rollback bypass this class exists to prevent (same reasoning as PR #151).
 * - the clock must be a non-negative safe integer (milliseconds), so a garbage
 *   reading cannot poison a client's high-water mark.
 */
export class EdgeRateThrottler {
  private backend: RateLimitBackend;
  private maxRequests: number;
  private windowSeconds: number;
  private clock: EdgeClock;
  private windowMs: number;
  private highWaterByClient = new Map<string, number>();
  private readonly maxTrackedClients: number;

  constructor(
    backend: RateLimitBackend,
    maxRequests = 60,
    windowSeconds = 60,
    clock: EdgeClock = () => Date.now(),
    maxTrackedClients = 10_000,
  ) {
    if (
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1 ||
      typeof clock !== "function" ||
      !Number.isSafeInteger(maxTrackedClients) ||
      maxTrackedClients < 1
    )
      throw new Error("Invalid edge limits");
    const windowMs = windowSeconds * 1000;
    if (!Number.isSafeInteger(windowMs)) throw new Error("Invalid edge limits");
    this.backend = backend;
    this.maxRequests = maxRequests;
    this.windowSeconds = windowSeconds;
    this.clock = clock;
    this.windowMs = windowMs;
    this.maxTrackedClients = maxTrackedClients;
  }

  public async isAllowed(
    clientId: string,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid edge clock");

    const wallWindow = Math.floor(now / this.windowMs);
    const previous = this.highWaterByClient.get(clientId);
    if (
      previous === undefined &&
      this.highWaterByClient.size >= this.maxTrackedClients
    )
      return { allowed: false, remaining: 0 };
    const window =
      previous === undefined ? wallWindow : Math.max(wallWindow, previous);
    this.highWaterByClient.set(clientId, window);

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
