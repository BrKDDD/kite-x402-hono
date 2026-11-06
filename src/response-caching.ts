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
    const ttlMs =
      ttlSeconds === undefined ? this.defaultTtlMs : ttlSeconds * 1000;
    const now = Date.now();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now + ttlMs))
      throw new Error("Invalid cache TTL");

    // Stage the replacement: validation failures must not remove live entries.
    const next = new Map(
      [...this.cache].filter(
        ([id, entry]) => id !== key && entry.expiresAt > now,
      ),
    );
    if (next.size >= this.maxEntries) {
      const oldest = next.keys().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
    const bytes = [...next.values()].reduce(
      (n, entry) => n + Buffer.byteLength(entry.body),
      0,
    );
    if (bytes + Buffer.byteLength(body) > 32 * 1024 * 1024)
      throw new Error("Response cache exceeds 32 MiB");

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

    next.set(key, entry);
    this.cache = next;
    return structuredClone(entry);
  }

  public clear(): void {
    this.cache.clear();
  }
}
