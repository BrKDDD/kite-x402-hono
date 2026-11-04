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

export class ResponseCacheStore {
  private cache = new Map<string, CachedResponseEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

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
      this.cache.delete(key);
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
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Cached response exceeds 1 MiB");
    for (const [id, entry] of this.cache)
      if (entry.expiresAt <= Date.now()) this.cache.delete(id);
    this.cache.delete(key);
    const bytes = [...this.cache.values()].reduce(
      (n, e) => n + Buffer.byteLength(e.body),
      0,
    );
    if (bytes + Buffer.byteLength(body) > 32 * 1024 * 1024)
      throw new Error("Response cache exceeds 32 MiB");
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const ttlMs =
      ttlSeconds === undefined ? this.defaultTtlMs : ttlSeconds * 1000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
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
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    this.cache.set(key, entry);
    return structuredClone(entry);
  }

  public clear(): void {
    this.cache.clear();
  }
}
