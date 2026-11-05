export interface ProbeResult {
  ready: boolean;
  checkedAt: number;
  details: Record<string, boolean>;
}

export class CachedReadinessProbe {
  private lastResult: ProbeResult | null = null;
  private ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  public getCachedOrStale(): ProbeResult | null {
    if (!this.lastResult) return null;
    if (Date.now() - this.lastResult.checkedAt > this.ttlMs) return null;
    return this.lastResult;
  }

  public recordStatus(ready: boolean, details: Record<string, boolean>): ProbeResult {
    const result: ProbeResult = {
      ready,
      checkedAt: Date.now(),
      details,
    };
    this.lastResult = result;
    return result;
  }
}
