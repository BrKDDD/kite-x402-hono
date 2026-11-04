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
    this.defaultTtlMs = options.defaultTtlSeconds * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  public generateKey(method: string, path: string, body?: string): string {
    const content = `${method.toUpperCase()}:${path}:${body || ""}`;
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
    return entry;
  }

  public set(
    key: string,
    body: string,
    status: number,
    headers: Record<string, string> = {},
    ttlSeconds?: number,
  ): CachedResponseEntry {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const ttlMs = ttlSeconds ? ttlSeconds * 1000 : this.defaultTtlMs;
    const etag = this.generateEtag(body);
    const entry: CachedResponseEntry = {
      body,
      status,
      headers: {
        ...headers,
        ETag: etag,
        "Cache-Control": `public, max-age=${Math.floor(ttlMs / 1000)}`,
      },
      etag,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    this.cache.set(key, entry);
    return entry;
  }

  public clear(): void {
    this.cache.clear();
  }
}
