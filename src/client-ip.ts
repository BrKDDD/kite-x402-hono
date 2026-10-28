import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import type { Config } from "./config.js";
import { extractClientIp } from "./firewall.js";

/** Resolve the socket peer by default; forwarded claims require explicit trust. */
export function clientIpResolver(
  config: Config,
): (c: Context) => string | null {
  const rules = config.trustedProxyCidrs ?? [];
  const trusted = new BlockList();
  for (const rule of rules) {
    const [address, prefix, extra] = rule.split("/");
    const family = address ? isIP(address) : 0;
    const bits = family === 4 ? 32 : 128;
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > bits))
    ) {
      throw new Error("TRUSTED_PROXY_CIDRS contains an invalid IP or CIDR");
    }
    if (prefix === undefined)
      trusted.addAddress(address!, family === 4 ? "ipv4" : "ipv6");
    else
      trusted.addSubnet(
        address!,
        Number(prefix),
        family === 4 ? "ipv4" : "ipv6",
      );
  }
  const isTrusted = (ip: string) => {
    const family = isIP(ip);
    return !!family && trusted.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
  return (c) => {
    const peer =
      typeof c.env?.clientIp === "string" && isIP(c.env.clientIp)
        ? (c.env.clientIp as string)
        : null;
    if (config.trustProxyHeaders !== true) return peer;
    // The explicit legacy flag is supported for an ingress that strips inbound
    // forwarding headers. CIDR rules additionally constrain trusted socket peers.
    if (!rules.length) {
      const claim = extractClientIp(c.req.raw.headers);
      return claim && isIP(claim) ? claim : peer;
    }
    if (!peer || !isTrusted(peer)) return peer;
    const forwarded = c.req.header("x-forwarded-for");
    if (!forwarded) {
      const claim = extractClientIp(c.req.raw.headers);
      return claim && isIP(claim) ? claim : peer;
    }
    const hops = forwarded.split(",").map((ip) => ip.trim());
    if (hops.length > 64 || hops.some((ip) => !isIP(ip))) return peer;
    let client = peer;
    for (let i = hops.length - 1; i >= 0 && isTrusted(client); i--)
      client = hops[i]!;
    return client;
  };
}
