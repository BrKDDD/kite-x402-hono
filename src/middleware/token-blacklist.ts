/** In-process revocations. Expiry is Unix milliseconds, not JWT exp seconds. */

/** Guard rail: no real JWT needs a decade of revocation. Blocks MAX_SAFE_INTEGER entries. */
const MAX_REVOCATION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

interface ExpiryEntry {
  jti: string;
  expiresAt: number;
}

export class TokenBlacklist {
  private revokedJtis = new Map<string, number>();
  private expiries: ExpiryEntry[] = [];
  private expiryIndex = new Map<string, number>();

  constructor(private readonly maxEntries = 10000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error("Invalid blacklist capacity");
  }

  public revoke(jti: string, expiresAt: number): void {
    if (
      !jti ||
      jti.length > 512 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0
    )
      throw new Error("Invalid revocation");
    const now = Date.now();
    // A far-future deadline is not a longer revocation — it is a permanent
    // entry that can never be reclaimed, which lets an attacker occupy the
    // whole list and disable revocation of genuinely compromised tokens.
    if (expiresAt > now + MAX_REVOCATION_TTL_MS)
      throw new Error("Invalid revocation");
    if (expiresAt <= now) return;

    this.reclaimExpired(now);
    if (!this.revokedJtis.has(jti) && this.revokedJtis.size >= this.maxEntries)
      throw new Error("Blacklist capacity reached");

    const effective = Math.max(expiresAt, this.revokedJtis.get(jti) ?? 0);
    if (this.revokedJtis.has(jti)) this.removeExpiry(jti);
    this.revokedJtis.set(jti, effective);
    this.pushExpiry(jti, effective);
  }

  public revokeJwt(jti: string, expSeconds: number): void {
    if (!Number.isSafeInteger(expSeconds))
      throw new Error("Invalid JWT expiry");
    this.revoke(jti, expSeconds * 1000);
  }

  public isRevoked(jti: string): boolean {
    const expiry = this.revokedJtis.get(jti);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.remove(jti);
      return false;
    }
    return true;
  }

  /** Pop entries whose deadline has passed. O(k log n) for k expired entries. */
  private reclaimExpired(now: number): void {
    for (;;) {
      const root = this.expiries[0];
      if (!root || root.expiresAt > now) return;
      this.remove(root.jti);
    }
  }

  private remove(jti: string): void {
    this.revokedJtis.delete(jti);
    this.removeExpiry(jti);
  }

  private pushExpiry(jti: string, expiresAt: number): void {
    const entry: ExpiryEntry = { jti, expiresAt };
    this.expiries.push(entry);
    this.siftUp(this.expiries.length - 1);
  }

  private removeExpiry(jti: string): void {
    const index = this.expiryIndex.get(jti);
    if (index === undefined) return;
    const last = this.expiries.pop()!;
    if (index < this.expiries.length) {
      this.expiries[index] = last;
      this.expiryIndex.set(last.jti, index);
      // The replacement may break heap order in either direction. Restore
      // upward first, then downward from where it actually settled; a
      // down-only fix can hide an expired entry below a live root.
      this.siftDown(this.siftUp(index));
    }
    this.expiryIndex.delete(jti);
  }

  /** Returns the final position of the sifted entry. */
  private siftUp(start: number): number {
    let i = start;
    const item = this.expiries[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.expiries[parent]!.expiresAt <= item.expiresAt) break;
      this.expiries[i] = this.expiries[parent]!;
      this.expiryIndex.set(this.expiries[i]!.jti, i);
      i = parent;
    }
    this.expiries[i] = item;
    this.expiryIndex.set(item.jti, i);
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
      this.expiryIndex.set(this.expiries[i]!.jti, i);
      i = child;
    }
    this.expiries[i] = item;
    this.expiryIndex.set(item.jti, i);
  }
}
