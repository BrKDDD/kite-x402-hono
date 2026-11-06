export interface HmacVerificationResult {
  isValid: boolean;
  error?: string;
}

export async function verifyHmacSignature(
  payload: string,
  secret: string,
  signatureHex: string,
  timestampHeader?: string,
  maxToleranceMs: number = 300000
): Promise<HmacVerificationResult> {
  if (timestampHeader) {
    const timestamp = parseInt(timestampHeader, 10);
    if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > maxToleranceMs) {
      return { isValid: false, error: 'Timestamp tolerance exceeded or invalid' };
    }
  }

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );

    const isValid = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      sigBytes,
      encoder.encode(payload)
    );

    return { isValid };
  } catch (err: any) {
    return { isValid: false, error: err.message || 'Signature calculation failed' };
  }
}

export default verifyHmacSignature;
