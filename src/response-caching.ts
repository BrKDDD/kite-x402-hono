/**
 * Payment-Aware HTTP Response Cache
 * Caches deterministic paid API responses with ETag generation and TTL expiration.
 */

import { createHash } from "crypto";

export interface CachedResponseEntry {
  body: string;
  status: number;
  headers: Record<string, string>;
  etag: string;
  expiresAt: number;
  createdAt: number;
}

export interface ResponseCacheOptions {
  defaultTtlSeconds: number;
  maxEntries?: number;
}

interface ExpiryEntry {
  key: string;
  expiresAt: number;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export class ResponseCacheStore {
  private cache = new Map<string, CachedResponseEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private cachedBytes = 0;
  private expiries: ExpiryEntry[] = [];
  private expiryIndex = new Map<string, number>();

  constructor(options: ResponseCacheOptions) {
    if (
      !Number.isFinite(options.defaultTtlSeconds) ||
      options.defaultTtlSeconds <= 0 ||
      !Number.isSafeInteger(options.maxEntries ?? 1000) ||
      (options.maxEntries ?? 1000) < 1
    )
      throw new Error("Invalid cache limits");
    this.defaultTtlMs = options.defaultTtlSeconds * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  public generateKey(method: string, path: string, body?: string): string {
    const content = JSON.stringify([method.toUpperCase(), path, body ?? ""]);
    return createHash("sha256").update(content).digest("hex");
  }

  public generateEtag(content: string): string {
    return `"${createHash("md5").update(content).digest("hex")}"`;
  }

  public get(key: string): CachedResponseEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.drop(key);
      return null;
    }
    return structuredClone(entry);
  }

  public set(
    key: string,
    body: string,
    status: number,
    headers: Record<string, string> = {},
    ttlSeconds?: number,
  ): CachedResponseEntry {
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > MAX_BODY_BYTES)
      throw new Error("Cached response exceeds 1 MiB");
    const ttlMs =
      ttlSeconds === undefined ? this.defaultTtlMs : ttlSeconds * 1000;
    const now = Date.now();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now + ttlMs))
      throw new Error("Invalid cache TTL");

    const etag = this.generateEtag(body);
    const entry: CachedResponseEntry = {
      body,
      status,
      headers: {
        ...Object.fromEntries(
          Object.entries(headers).filter(([k]) =>
            ["content-type", "content-language"].includes(k.toLowerCase()),
          ),
        ),
        ETag: etag,
        "Cache-Control": "private, no-store",
      },
      etag,
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    // Materialise both copies before touching any live state. Both can throw
    // DataCloneError on input from an untyped caller, so neither may run after
    // the cache, its FIFO order or the byte/expiry indexes are mutated: a
    // failed write must leave all of them, and the previous paid response,
    // untouched. Storing a clone rather than `entry` also severs references to
    // caller-owned objects, so mutating them after a successful set() cannot
    // poison a later get().
    const stored = structuredClone(entry);
    const snapshot = structuredClone(stored);

    // The staged write rebuilt a Map without the replaced key and without
    // expired entries. Detach lapsed heap nodes first so the byte budget can
    // be computed without a full scan, but keep every entry in the Map until
    // the write is accepted: a rejected write must leave the cache untouched.
    const lapsed = new Set<string>();
    for (;;) {
      const root = this.expiries[0];
      if (!root || root.expiresAt > now) break;
      this.removeExpiry(root.key);
      lapsed.add(root.key);
    }

    const previous = this.cache.get(key);
    const replaceExisting = previous !== undefined && !lapsed.has(key);

    // Capacity eviction follows Map insertion order and removes only one
    // entry, as in the staged Map. Decide it before the byte check: the old
    // code evicted first, so a full cache could still accept a same-size write.
    let evictKey: string | undefined;
    if (
      this.cache.size - lapsed.size - (replaceExisting ? 1 : 0) >=
      this.maxEntries
    ) {
      for (const id of this.cache.keys()) {
        if (id !== key && !lapsed.has(id)) {
          evictKey = id;
          break;
        }
      }
    }

    let projectedBytes = this.cachedBytes + bodyBytes;
    for (const id of lapsed)
      projectedBytes -= Buffer.byteLength(this.cache.get(id)!.body);
    if (replaceExisting) projectedBytes -= Buffer.byteLength(previous!.body);
    if (evictKey !== undefined)
      projectedBytes -= Buffer.byteLength(this.cache.get(evictKey)!.body);

    if (projectedBytes > MAX_CACHE_BYTES) {
      // Restore the index before reporting failure. Rebuilding from the Map is
      // O(n), but this is the rejection path and a half-detached heap would no
      // longer describe the live cache.
      this.rebuildExpiryIndex();
      throw new Error("Response cache exceeds 32 MiB");
    }

    // Commit: no throw past this point. Lapsed nodes were already detached.
    for (const id of lapsed) this.deleteFromCache(id);
    if (evictKey !== undefined) this.drop(evictKey);
    if (replaceExisting) this.drop(key);

    this.cache.set(key, stored);
    this.cachedBytes += bodyBytes;
    this.pushExpiry(key, stored.expiresAt);
    return snapshot;
  }

  public clear(): void {
    this.cache.clear();
    this.cachedBytes = 0;
    this.expiries = [];
    this.expiryIndex.clear();
  }

  private deleteFromCache(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cachedBytes -= Buffer.byteLength(entry.body);
  }

  private drop(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.deleteFromCache(key);
    this.removeExpiry(key);
  }

  private rebuildExpiryIndex(): void {
    this.expiries = [];
    this.expiryIndex.clear();
    for (const [key, entry] of this.cache)
      this.pushExpiry(key, entry.expiresAt);
  }

  private pushExpiry(key: string, expiresAt: number): void {
    const index = this.expiries.length;
    this.expiries.push({ key, expiresAt });
    this.expiryIndex.set(key, index);
    this.siftUp(index);
  }

  private removeExpiry(key: string): void {
    const index = this.expiryIndex.get(key);
    if (index === undefined) return;
    const last = this.expiries.pop()!;
    this.expiryIndex.delete(key);
    if (index < this.expiries.length) {
      this.expiries[index] = last;
      this.expiryIndex.set(last.key, index);
      const parent = (index - 1) >> 1;
      if (
        index > 0 &&
        this.expiries[index]!.expiresAt < this.expiries[parent]!.expiresAt
      ) {
        this.siftUp(index);
      } else {
        this.siftDown(index);
      }
    }
  }

  private siftUp(start: number): void {
    let index = start;
    const item = this.expiries[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.expiries[parent]!.expiresAt <= item.expiresAt) break;
      this.expiries[index] = this.expiries[parent]!;
      this.expiryIndex.set(this.expiries[index]!.key, index);
      index = parent;
    }
    this.expiries[index] = item;
    this.expiryIndex.set(item.key, index);
  }

  private siftDown(start: number): void {
    let index = start;
    const length = this.expiries.length;
    const item = this.expiries[index]!;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      const child =
        right < length &&
        this.expiries[right]!.expiresAt < this.expiries[left]!.expiresAt
          ? right
          : left;
      if (item.expiresAt <= this.expiries[child]!.expiresAt) break;
      this.expiries[index] = this.expiries[child]!;
      this.expiryIndex.set(this.expiries[index]!.key, index);
      index = child;
    }
    this.expiries[index] = item;
    this.expiryIndex.set(item.key, index);
  }
}
