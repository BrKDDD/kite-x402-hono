export function isValidCorsOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}
