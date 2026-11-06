import { isSerializedOrigin } from "./cors-preflight-guard.js";

/** Caller supplies an anchored hostname allowlist; HTTPS serialized origins only. */
export function matchSubdomainOrigin(origin: string, pattern: RegExp): boolean {
  if (!isSerializedOrigin(origin) || !origin.startsWith("https://"))
    return false;
  // Copy to avoid changing caller state and disable stateful matching flags.
  const stable = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  const hostname = new URL(origin).hostname;
  const match = stable.exec(hostname);
  return match !== null && match.index === 0 && match[0] === hostname;
}
