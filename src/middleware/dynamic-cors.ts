export function matchSubdomainOrigin(origin: string, pattern: RegExp): boolean {
  try {
    const url = new URL(origin);
    return pattern.test(url.hostname);
  } catch {
    return false;
  }
}
