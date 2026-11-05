export class TokenBlacklist {
  private revokedJtis = new Map<string, number>();

  public revoke(jti: string, expiresAt: number) {
    this.revokedJtis.set(jti, expiresAt);
  }

  public isRevoked(jti: string): boolean {
    const expiresAt = this.revokedJtis.get(jti);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.revokedJtis.delete(jti);
      return false;
    }
    return true;
  }
}
