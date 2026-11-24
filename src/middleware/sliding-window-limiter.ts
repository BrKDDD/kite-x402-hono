export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

interface ExpiryEntry {
  key: string;
  /** Largest timestamp recorded for this key (the tail of its sorted window). */
  expiresAt: number;
}

/**
 * Fixed-budget sliding window limiter.
 *
 * Two invariants make the verdict stable:
 * - each key's timestamp array is kept ascending, so `[0]` is the oldest live
 *   request and `at(-1)` is the newest even after a backward clock step;
 * - a min-heap keyed by each key's newest timestamp drives reclamation, so an
 *   expired key costs O(log n) to remove instead of scanning every key on each
 *   call (including rejected calls).
 *
 * Capacity remains fail-closed: when the map is full, a brand-new key is denied
 * rather than evicting an incumbent. LRU eviction would let a flood of fresh
 * keys erase legitimate identities' windows — the same bypass as a clock
 * rollback. See docs/sliding-window-limiter-clock-and-capacity.md.
 */
export class SlidingWindowLimiter {
  private windows = new Map<string, number[]>();
  private expiries: ExpiryEntry[] = [];
  private expiryIndex = new Map<string, number>();
  private readonly windowSizeMs: number;
  private readonly maxRequests: number;
  private readonly maxKeys: number;

  constructor(windowSizeMs = 60000, maxRequests = 120, maxKeys = 10000) {
    if (
      !Number.isSafeInteger(windowSizeMs) ||
      windowSizeMs < 1 ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      !Number.isSafeInteger(maxKeys) ||
      maxKeys < 1
    )
      throw new Error("Invalid window limits");
    this.windowSizeMs = windowSizeMs;
    this.maxRequests = maxRequests;
    this.maxKeys = maxKeys;
  }

  public check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowSizeMs;
    this.reclaimExpired(cutoff);

    if (!this.windows.has(key) && this.windows.size >= this.maxKeys)
      return {
        allowed: false,
        remaining: 0,
        resetSeconds: Math.ceil(this.windowSizeMs / 1000),
      };

    let timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      // Array is ascending, so [0] is the request closest to leaving the window.
      const oldest = timestamps[0]!;
      const resetSeconds = Math.ceil((oldest + this.windowSizeMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetSeconds: Math.max(1, resetSeconds),
      };
    }

    // A backward clock step must not insert a timestamp older than entries
    // that are already recorded: it would become a fake "oldest live request",
    // inflating resetSeconds and holding a slot that has really expired.
    // Clamp to the newest recorded time so each window stays monotonic.
    const effectiveNow = Math.max(
      now,
      timestamps[timestamps.length - 1] ?? now,
    );
    insertSorted(timestamps, effectiveNow);
    this.windows.set(key, timestamps);
    this.setExpiry(key, timestamps[timestamps.length - 1]!);

    return {
      allowed: true,
      remaining: this.maxRequests - timestamps.length,
      resetSeconds: Math.ceil(this.windowSizeMs / 1000),
    };
  }

  /** Drop keys whose newest request is older than the whole window. */
  private reclaimExpired(cutoff: number): void {
    for (;;) {
      const root = this.expiries[0];
      if (root === undefined || root.expiresAt > cutoff) return;
      this.windows.delete(root.key);
      this.removeExpiry(root.key);
    }
  }

  private setExpiry(key: string, expiresAt: number): void {
    const index = this.expiryIndex.get(key);
    if (index === undefined) {
      this.expiries.push({ key, expiresAt });
      this.siftUp(this.expiries.length - 1);
      return;
    }
    const entry = this.expiries[index]!;
    entry.expiresAt = expiresAt;
    // A newer deadline sinks; a backward clock step raises it. Handle both.
    this.siftDown(this.siftUp(index));
  }

  private removeExpiry(key: string): void {
    const index = this.expiryIndex.get(key);
    if (index === undefined) return;
    const last = this.expiries.pop()!;
    if (index < this.expiries.length) {
      this.expiries[index] = last;
      this.expiryIndex.set(last.key, index);
      this.siftDown(this.siftUp(index));
    }
    this.expiryIndex.delete(key);
  }

  /** Returns the final position of the sifted entry. */
  private siftUp(start: number): number {
    let i = start;
    const item = this.expiries[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.expiries[parent]!.expiresAt <= item.expiresAt) break;
      this.expiries[i] = this.expiries[parent]!;
      this.expiryIndex.set(this.expiries[i]!.key, i);
      i = parent;
    }
    this.expiries[i] = item;
    this.expiryIndex.set(item.key, i);
    return i;
  }

  private siftDown(start: number): void {
    let i = start;
    const size = this.expiries.length;
    const item = this.expiries[i]!;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= size) break;
      const right = left + 1;
      let child = left;
      if (
        right < size &&
        this.expiries[right]!.expiresAt < this.expiries[left]!.expiresAt
      )
        child = right;
      if (this.expiries[child]!.expiresAt >= item.expiresAt) break;
      this.expiries[i] = this.expiries[child]!;
      this.expiryIndex.set(this.expiries[i]!.key, i);
      i = child;
    }
    this.expiries[i] = item;
    this.expiryIndex.set(item.key, i);
  }
}

/** Insert while keeping the array ascending (duplicates allowed). */
function insertSorted(timestamps: number[], value: number): void {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (timestamps[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  timestamps.splice(low, 0, value);
}
