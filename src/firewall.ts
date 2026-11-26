import { BlockList, isIP } from "node:net";

export interface IpFilterConfig {
  allowlist?: string[] | undefined;
  blocklist?: string[] | undefined;
}

export interface IpFilterVerdict {
  allowed: boolean;
  reason?: "blocked_by_blocklist" | "not_in_allowlist" | "invalid_ip";
}

/**
 * Parses comma-separated IP or CIDR strings into a cleaned array.
 */
export function parseIpList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const rules = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const rule of rules) {
    if (!parseRule(rule))
      throw new Error(`Invalid firewall IP or CIDR: ${rule}`);
  }
  return rules;
}

function parseRule(
  rule: string,
): { address: string; family: "ipv4" | "ipv6"; prefix?: number } | null {
  const [address, prefix, extra] = rule.trim().split("/");
  const version = address ? isIP(address) : 0;
  if (
    !version ||
    extra !== undefined ||
    (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))
  )
    return null;
  return {
    address: address!,
    family: version === 4 ? "ipv4" : "ipv6",
    ...(prefix === undefined ? {} : { prefix: Number(prefix) }),
  };
}

/**
 * Converts an IPv4 string (e.g. "192.168.1.1") to a 32-bit unsigned integer.
 */
export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    num = (num << 8) + byte;
  }
  return num >>> 0;
}

/**
 * Checks whether an IPv4 address falls within a given CIDR block (e.g. "10.0.0.0/8" or "192.168.1.1").
 */
export function matchIpv4Cidr(ip: string, rule: string): boolean {
  const parts = rule.split("/");
  const subnet = parts[0];
  const prefixStr = parts[1];

  if (!subnet || !parseRule(rule) || isIP(subnet) !== 4) return false;
  const ipNum = ipv4ToNumber(ip);
  const subnetNum = ipv4ToNumber(subnet);

  if (ipNum === null || subnetNum === null) {
    return false;
  }

  if (prefixStr === undefined) {
    return ipNum === subnetNum;
  }

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (subnetNum & mask);
}

/**
 * Matches IPv4, IPv6 and mapped addresses using the same parser on both sides.
 */
export function matchesIpRule(clientIp: string, rule: string): boolean {
  const client = clientIp.trim();
  const family = isIP(client);
  const parsed = parseRule(rule);
  if (!family || !parsed) return false;
  const list = new BlockList();
  if (parsed.prefix === undefined)
    list.addAddress(parsed.address, parsed.family);
  else list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  return list.check(client, family === 4 ? "ipv4" : "ipv6");
}

function parseClientIp(
  clientIp: string | null | undefined,
): { cleanIp: string; family: "ipv4" | "ipv6" } | null {
  if (!clientIp) return null;
  const cleanIp = clientIp.trim();
  const version = isIP(cleanIp);
  if (!version) return null;
  return { cleanIp, family: version === 4 ? "ipv4" : "ipv6" };
}

function compileRuleList(
  rules: readonly string[] | undefined,
): BlockList | null {
  const snapshot = [...(rules ?? [])];
  if (snapshot.length === 0) return null;
  const compiled = new BlockList();
  for (const rule of snapshot) {
    const parsed = typeof rule === "string" ? parseRule(rule) : null;
    if (!parsed) {
      throw new Error(`Invalid firewall IP or CIDR: ${String(rule)}`);
    }
    if (parsed.prefix === undefined) {
      compiled.addAddress(parsed.address, parsed.family);
    } else {
      compiled.addSubnet(parsed.address, parsed.prefix, parsed.family);
    }
  }
  return compiled;
}

/**
 * Compiles and snapshots firewall rules once so invalid rules fail configuration
 * and caller-owned array mutations cannot alter an installed policy.
 */
export function createIpFirewall(
  config: IpFilterConfig,
): ((clientIp: string | null | undefined) => IpFilterVerdict) | null {
  const blocklist = compileRuleList(config.blocklist);
  const allowlist = compileRuleList(config.allowlist);
  if (!blocklist && !allowlist) return null;

  return (clientIp) => {
    const parsed = parseClientIp(clientIp);
    if (!parsed) {
      return { allowed: false, reason: "invalid_ip" };
    }
    if (blocklist?.check(parsed.cleanIp, parsed.family)) {
      return { allowed: false, reason: "blocked_by_blocklist" };
    }
    if (allowlist && !allowlist.check(parsed.cleanIp, parsed.family)) {
      return { allowed: false, reason: "not_in_allowlist" };
    }
    return { allowed: true };
  };
}

/**
 * Evaluates a client IP against configured allowlists and blocklists.
 */
export function evaluateIpFilter(
  clientIp: string | null | undefined,
  config: IpFilterConfig,
): IpFilterVerdict {
  const check = createIpFirewall(config);
  if (check) return check(clientIp);
  return parseClientIp(clientIp)
    ? { allowed: true }
    : { allowed: false, reason: "invalid_ip" };
}

/**
 * Resolves client IP address from proxy request headers.
 */
export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    const client = first ? first.trim() : "";
    if (client.length > 0) return client;
  }

  const realIp = headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  return null;
}
