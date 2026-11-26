/**
 * In-memory sliding-window nonce replay protection for x402 payments.
 *
 * Prevents malicious or accidental reuse of EIP-3009 payment authorizations
 * by tracking (payer, nonce) pairs and protecting against concurrent in-flight replays.
 */

export interface NonceGuardOptions {
  /**
   * Sliding window TTL for consumed nonces in milliseconds.
   * Default: 15 minutes (900,000 ms).
   */
  consumedTtlMs?: number;

  /**
   * Legacy option, retained for configuration compatibility. Active leases no
   * longer expire by time; the request owner must release or commit them.
   */
  inFlightTtlMs?: number;

  /**
   * Maximum tracked entries before opportunistic purge.
   * Default: 10,000.
   */
  maxEntries?: number;

  /**
   * Minimum interval between opportunistic expiry sweeps, in milliseconds.
   * Default: 1000. Use 0 to sweep on every acquisition.
   *
   * A sweep walks every tracked entry, so running one per acquisition makes the
   * cost of a payment proportional to the size of the map. Throttling bounds
   * that cost without weakening replay decisions: `check` and `acquire` read the
   * target entry's own expiry, so a lapsed nonce is still treated as expired
   * before the entry is reclaimed. A full scan still runs whenever the entry cap
   * is reached, so throttling cannot turn a reclaimable slot into a refusal.
   */
  sweepIntervalMs?: number;
}

export type NonceStatus = "CONSUMED" | "IN_FLIGHT" | "AVAILABLE";

export interface NonceEntry {
  status: "CONSUMED" | "IN_FLIGHT";
  expiresAt: number;
}

export class PaymentNonceReplayGuard {
  private readonly consumedTtlMs: number;
  private readonly inFlightTtlMs: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private readonly entries = new Map<string, NonceEntry>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private sweepRuns = 0;

  constructor(options: NonceGuardOptions = {}) {
    this.consumedTtlMs = options.consumedTtlMs ?? 15 * 60 * 1000;
    this.inFlightTtlMs = options.inFlightTtlMs ?? 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
    for (const n of [this.maxEntries, this.inFlightTtlMs, this.consumedTtlMs])
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error("Invalid nonce guard limit");
    if (!Number.isSafeInteger(this.sweepIntervalMs) || this.sweepIntervalMs < 0)
      throw new Error("Invalid nonce guard sweep interval");
  }

  /**
   * Number of scheduled opportunistic sweeps performed so far. Exposed so an
   * operator can confirm sweeping cost stays bounded instead of scaling with
   * traffic. Forced reclaims on the cap path are not counted here.
   */
  public get sweepCount(): number {
    return this.sweepRuns;
  }

  private buildKey(payer: string, nonce: string): string {
    return `${payer.trim().toLowerCase()}:${nonce.trim().toLowerCase()}`;
  }

  /**
   * Attempts to acquire an in-flight lease for the given (payer, nonce).
   * Returns true if acquired, false if already consumed or currently in-flight.
   */
  public acquire(
    payer: string,
    nonce: string,
    now: number = Date.now(),
  ): boolean {
    this.sweepIfDue(now);
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);

    if (existing) {
      if (existing.expiresAt > now) {
        return false; // Replay attempt detected!
      }
      this.entries.delete(key);
    }

    if (this.entries.size >= this.maxEntries) {
      // A throttled sweep may still be counting entries that already lapsed.
      // Reclaim them before refusing, so the cap reflects live leases only.
      this.purgeExact(now);
      if (this.entries.size >= this.maxEntries) {
        return false;
      }
    }

    this.entries.set(key, {
      status: "IN_FLIGHT",
      expiresAt: Number.POSITIVE_INFINITY,
    });
    return true;
  }

  /** Acquire an owner-bound lease; stale owners cannot modify a replacement. */
  public reserve(
    payer: string,
    nonce: string,
    now: number = Date.now(),
  ): {
    commit: (at?: number) => void;
    release: () => void;
  } | null {
    if (!this.acquire(payer, nonce, now)) return null;
    const key = this.buildKey(payer, nonce);
    const entry = this.entries.get(key)!;
    return {
      commit: (at = Date.now()) => {
        if (this.entries.get(key) !== entry) return;
        entry.status = "CONSUMED";
        entry.expiresAt = at + this.consumedTtlMs;
      },
      release: () => {
        if (this.entries.get(key) === entry && entry.status === "IN_FLIGHT")
          this.entries.delete(key);
      },
    };
  }

  /**
   * Retains the nonce for consumedTtlMs when settlement begins or succeeds.
   */
  public commit(payer: string, nonce: string, now: number = Date.now()): void {
    const key = this.buildKey(payer, nonce);
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // Dropping a consumed nonce would report it AVAILABLE on a later lookup,
      // so reclaim lapsed entries first and only give up at a genuine cap.
      this.purgeExact(now);
      if (this.entries.size >= this.maxEntries) return;
    }
    this.entries.set(key, {
      status: "CONSUMED",
      expiresAt: now + this.consumedTtlMs,
    });
  }

  /**
   * Releases an in-flight lease if verification or proxying failed before settlement.
   */
  public release(payer: string, nonce: string): void {
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);
    if (existing && existing.status === "IN_FLIGHT") {
      this.entries.delete(key);
    }
  }

  /**
   * Queries status of a given (payer, nonce).
   */
  public check(
    payer: string,
    nonce: string,
    now: number = Date.now(),
  ): NonceStatus {
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);
    if (!existing || existing.expiresAt <= now) {
      return "AVAILABLE";
    }
    return existing.status;
  }

  /**
   * Returns current count of active tracked nonces.
   */
  public size(now: number = Date.now()): number {
    this.cleanExpired(now);
    return this.entries.size;
  }

  /**
   * Clears all entries.
   */
  public clear(): void {
    this.entries.clear();
  }

  private cleanExpired(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  /** Reclaims lapsed entries at most once per configured interval. */
  private sweepIfDue(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    this.sweepRuns++;
    this.cleanExpired(now);
  }

  /** Exact reclaim, reserved for paths where a stale count changes a decision. */
  private purgeExact(now: number): void {
    this.lastSweepAt = now;
    this.cleanExpired(now);
  }
}
