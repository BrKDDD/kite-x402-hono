export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:~-]{1,128}$/;

export interface CachedResponse {
  statusCode: number;
  headers: [string, string][];
  body: Uint8Array;
  cachedAt: number;
  expiresAt: number;
}

interface InFlightEntry {
  state: "in_flight";
  fingerprint: string | undefined;
  startedAt: number;
  expiresAt: number;
}

interface CompletedEntry {
  state: "completed";
  fingerprint: string | undefined;
  response: CachedResponse;
}

type IdempotencyRecord = InFlightEntry | CompletedEntry;

export interface IdempotencyCacheOptions {
  ttlMs?: number;
  maxKeys?: number;
  maxBytes?: number;
}

export class IdempotencyCache {
  private records = new Map<string, IdempotencyRecord>();
  private defaultTtlMs: number;
  private maxKeys: number;
  private maxBytes: number;
  /**
   * Keys of completed records, oldest completion first.
   *
   * The capacities this cache serves sit on the paid request path, so eviction
   * cannot afford to materialise every record to find one that is evictable.
   * Keeping this index makes that lookup the first element of a Set.
   */
  private completedKeys = new Set<string>();
  /**
   * Body bytes accounted to completed records.
   *
   * Maintained incrementally so `complete()` does not have to sum the cache on
   * every paid response. The invariant is checked by `bytes()`.
   */
  private cachedBytes = 0;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.maxKeys = options.maxKeys ?? 1000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    for (const n of [this.defaultTtlMs, this.maxKeys, this.maxBytes])
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error("Invalid cache limit");
  }

  public validateKey(key: string | null | undefined): boolean {
    if (!key) return false;
    return IDEMPOTENCY_KEY_PATTERN.test(key);
  }

  /**
   * Body bytes currently held by completed records.
   *
   * Exposed so the incremental accounting above is observable, and so a caller
   * can size `maxBytes` against real traffic instead of guessing.
   */
  public bytes(): number {
    return this.cachedBytes;
  }

  public cleanExpired(now = Date.now()): void {
    for (const [key, record] of this.records.entries()) {
      if (record.state === "completed" && now >= record.response.expiresAt) {
        this.drop(key);
      }
    }
  }

  /** Removes one record and releases whatever it accounted for. */
  private drop(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    if (record.state === "completed") {
      this.cachedBytes -= record.response.body.byteLength;
      this.completedKeys.delete(key);
    }
  }

  /** A supplied fingerprint must match for both in-flight and completed requests. */
  public acquire(
    key: string,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
    fingerprint?: string,
  ):
    | { status: "acquired" }
    | { status: "conflict" }
    | { status: "in_flight" }
    | { status: "cached"; response: CachedResponse } {
    const existing = this.records.get(key);
    if (existing) {
      // Expiry is decided for this key alone, so an acquisition never pays for a
      // scan of the whole cache. In-flight reservations carry an infinite expiry
      // and are released by their owner, so they are never dropped here.
      if (
        existing.state === "completed" &&
        now >= existing.response.expiresAt
      ) {
        this.drop(key);
      } else {
        if (existing.fingerprint !== fingerprint) {
          return { status: "conflict" };
        }
        if (existing.state === "in_flight") {
          return { status: "in_flight" };
        }
        return { status: "cached", response: existing.response };
      }
    }

    if (this.records.size >= this.maxKeys) {
      // Eviction needs no scan. Only completed records can be evictable (in-flight
      // reservations are held by their owner), and a lapsed record is completed
      // too, so the oldest completion is also the first candidate to reclaim.
      const oldestKey = this.completedKeys.values().next().value;
      // A full cache of live reservations is a conflict, not a licence to
      // discard work another request is still holding.
      if (oldestKey === undefined) return { status: "conflict" };
      this.drop(oldestKey);
    }

    this.records.set(key, {
      state: "in_flight",
      fingerprint,
      startedAt: now,
      expiresAt: Number.POSITIVE_INFINITY, // Request owner releases the reservation.
    });

    return { status: "acquired" };
  }

  public complete(
    key: string,
    statusCode: number,
    headers: Headers,
    body: Uint8Array,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
  ): void {
    const record = this.records.get(key);
    if (!record) return;
    const bodyBytes = body.byteLength;
    // Replacing a completed record removes its body from the budget first, which
    // is what the previous accounting did by excluding the current key from the sum.
    const previous = record.state === "completed" ? record : undefined;
    const replacedBytes = previous?.response.body.byteLength ?? 0;
    if (this.cachedBytes - replacedBytes + bodyBytes > this.maxBytes) {
      this.drop(key);
      return;
    }
    const headerEntries: [string, string][] = [];
    headers.forEach((val, name) => {
      // Don't cache transfer-encoding, connection, or hop-by-hop headers
      const lower = name.toLowerCase();
      if (
        [
          "content-type",
          "content-language",
          "etag",
          "last-modified",
          "payment-response",
        ].includes(lower)
      ) {
        headerEntries.push([name, val]);
      }
    });

    if (previous) this.drop(key);
    this.records.set(key, {
      state: "completed",
      fingerprint: record.fingerprint,
      response: {
        statusCode,
        headers: headerEntries,
        body: body.slice(),
        cachedAt: now,
        expiresAt: now + ttlMs,
      },
    });
    this.cachedBytes += bodyBytes;
    this.completedKeys.add(key);
  }

  public release(key: string): void {
    const existing = this.records.get(key);
    if (existing && existing.state === "in_flight") {
      this.drop(key);
    }
  }

  public size(): number {
    return this.records.size;
  }

  public clear(): void {
    this.records.clear();
    this.completedKeys.clear();
    this.cachedBytes = 0;
  }
}
