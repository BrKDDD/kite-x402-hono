import crypto from 'crypto';

export class SignedCookieManager {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  public sign(value: string): string {
    const signature = crypto.createHmac('sha256', this.secret).update(value).digest('base64url');
    return `${value}.${signature}`;
  }

  public verify(signedValue: string): string | null {
    const lastDot = signedValue.lastIndexOf('.');
    if (lastDot === -1) return null;

    const value = signedValue.slice(0, lastDot);
    const expected = this.sign(value);
    if (crypto.timingSafeEqual(Buffer.from(signedValue), Buffer.from(expected))) {
      return value;
    }
    return null;
  }
}
