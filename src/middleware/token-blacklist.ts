/** In-process revocations. Expiry is Unix milliseconds, not JWT exp seconds. */
export class TokenBlacklist {
  private revokedJtis = new Map<string, number>();
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
    for (const [key, expiry] of this.revokedJtis)
      if (expiry <= now) this.revokedJtis.delete(key);
    if (expiresAt <= now) return;
    if (!this.revokedJtis.has(jti) && this.revokedJtis.size >= this.maxEntries)
      throw new Error("Blacklist capacity reached");
    this.revokedJtis.set(
      jti,
      Math.max(expiresAt, this.revokedJtis.get(jti) ?? 0),
    );
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
      this.revokedJtis.delete(jti);
      return false;
    }
    return true;
  }
}
