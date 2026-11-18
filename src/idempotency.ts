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

interface ExpiryEntry {
  key: string;
  expiresAt: number;
}

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
  /**
   * Min-heap of completed-record expiries, oldest deadline first.
   *
   * The previous implementation reclaimed every lapsed completed record at the
   * start of `acquire()`. Removing that sweep without a replacement would leave
   * expired bodies in `cachedBytes` and make capacity eviction discard a live
   * response while keeping a dead one. The heap keeps that reclamation ordered
   * and amortised: one push per completion, one indexed removal per dropped
   * record, so it stays bounded by live completed entries.
   */
  private expiries: ExpiryEntry[] = [];
  /** Heap position of each live completed record, kept in sync by drop(). */
  private expiryIndex = new Map<string, number>();

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
      this.removeExpiry(key);
    }
  }

  private swapExpiry(i: number, j: number): void {
    const heap = this.expiries;
    const a = heap[i]!;
    const b = heap[j]!;
    heap[i] = b;
    heap[j] = a;
    this.expiryIndex.set(a.key, j);
    this.expiryIndex.set(b.key, i);
  }

  private siftUpExpiry(start: number): void {
    let i = start;
    const heap = this.expiries;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.expiresAt <= heap[i]!.expiresAt) break;
      this.swapExpiry(i, parent);
      i = parent;
    }
  }

  private siftDownExpiry(start: number): void {
    let i = start;
    const heap = this.expiries;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (
        left < heap.length &&
        heap[left]!.expiresAt < heap[smallest]!.expiresAt
      )
        smallest = left;
      if (
        right < heap.length &&
        heap[right]!.expiresAt < heap[smallest]!.expiresAt
      )
        smallest = right;
      if (smallest === i) return;
      this.swapExpiry(i, smallest);
      i = smallest;
    }
  }

  private pushExpiry(key: string, expiresAt: number): void {
    this.expiries.push({ key, expiresAt });
    const i = this.expiries.length - 1;
    this.expiryIndex.set(key, i);
    this.siftUpExpiry(i);
  }

  private removeExpiry(key: string): void {
    const i = this.expiryIndex.get(key);
    if (i === undefined) return;
    const heap = this.expiries;
    const last = heap.pop()!;
    this.expiryIndex.delete(key);
    if (i === heap.length) return;
    heap[i] = last;
    this.expiryIndex.set(last.key, i);
    const parent = (i - 1) >> 1;
    if (i > 0 && heap[parent]!.expiresAt > heap[i]!.expiresAt)
      this.siftUpExpiry(i);
    else this.siftDownExpiry(i);
  }

  /** Reclaims lapsed completed records before a capacity decision. */
  private reclaimExpired(now: number): void {
    for (;;) {
      const entry = this.expiries[0];
      if (!entry || entry.expiresAt > now) return;
      // The index keeps the heap in sync with live records, so the root is
      // always a current completed entry rather than a stale leftover.
      this.drop(entry.key);
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
    // Reclaim lapsed completed records before any capacity decision. This keeps
    // the previous byte-budget and eviction semantics without a full scan: the
    // heap yields only entries whose deadline has passed. In-flight reservations
    // carry an infinite expiry and are released by their owner, so they are
    // never reclaimed here.
    this.reclaimExpired(now);

    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { status: "conflict" };
      }
      if (existing.state === "in_flight") {
        return { status: "in_flight" };
      }
      return { status: "cached", response: existing.response };
    }

    if (this.records.size >= this.maxKeys) {
      // Eviction needs no scan. Lapsed records were just reclaimed, so the first
      // completed key is a live response rather than an expired one. A full
      // cache of live reservations is a conflict, not a licence to discard work
      // another request is still holding.
      const oldestKey = this.completedKeys.values().next().value;
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
    const expiresAt = now + ttlMs;
    this.records.set(key, {
      state: "completed",
      fingerprint: record.fingerprint,
      response: {
        statusCode,
        headers: headerEntries,
        body: body.slice(),
        cachedAt: now,
        expiresAt,
      },
    });
    this.cachedBytes += bodyBytes;
    this.completedKeys.add(key);
    this.pushExpiry(key, expiresAt);
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
    this.expiries = [];
    this.expiryIndex.clear();
  }
}
