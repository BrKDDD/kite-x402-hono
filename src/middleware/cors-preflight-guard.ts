/** Accept only serialized HTTP(S) origins, never URL paths or credentials. */
export function isSerializedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
}

export function isValidCorsOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
  credentials = false,
): boolean {
  if (!origin || !isSerializedOrigin(origin)) return false;
  if (allowedOrigins.includes(origin)) return true;
  return !credentials && allowedOrigins.includes("*");
}
