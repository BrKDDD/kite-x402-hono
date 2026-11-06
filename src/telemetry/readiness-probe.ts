export interface ProbeResult {
  ready: boolean;
  checkedAt: number;
  details: Record<string, boolean>;
}

export class CachedReadinessProbe {
  private lastResult: ProbeResult | null = null;
  private ttlMs: number;

  constructor(ttlMs = 5000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("Invalid probe TTL");
    this.ttlMs = ttlMs;
  }

  /** Returns a fresh snapshot or null; expired readiness is never served. */
  public getCachedOrStale(): ProbeResult | null {
    if (!this.lastResult) return null;
    if (Date.now() - this.lastResult.checkedAt >= this.ttlMs) return null;
    return structuredClone(this.lastResult);
  }

  public recordStatus(
    ready: boolean,
    details: Record<string, boolean>,
  ): ProbeResult {
    const result: ProbeResult = {
      ready,
      checkedAt: Date.now(),
      details: { ...details },
    };
    this.lastResult = result;
    return structuredClone(result);
  }
}
