export class LatencyHistogram {
  private readonly buckets: number[] = [10, 25, 50, 100, 250, 500, 1000, 2500];
  private readonly counts: number[];
  private totalCount = 0;
  private sumMs = 0;

  constructor() {
    this.counts = new Array(this.buckets.length + 1).fill(0);
  }

  public record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error("Invalid duration");
    this.totalCount++;
    this.sumMs += durationMs;

    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (durationMs <= this.buckets[i]!) {
        this.counts[i] = (this.counts[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      this.counts[this.counts.length - 1] = (this.counts.at(-1) ?? 0) + 1;
    }
  }

  public getStats() {
    return {
      totalCount: this.totalCount,
      averageMs: this.totalCount > 0 ? this.sumMs / this.totalCount : 0,
      buckets: this.buckets.map((b, i) => ({ le: b, count: this.counts[i] })),
      overflowCount: this.counts[this.counts.length - 1],
    };
  }
}
