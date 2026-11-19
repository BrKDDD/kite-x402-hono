import { loadConfig } from "./config.js";
import { parsePrice } from "./networks.js";

export interface ConfigDiagnostic {
  field: string;
  message: string;
}
export interface ConfigPreflightReport {
  ok: boolean;
  scope: "configuration-only";
  errors: ConfigDiagnostic[];
  warnings: ConfigDiagnostic[];
  summary?: { network: string; asset: string; priceAtomic: string };
}

// A valid isolated baseline lets each field reuse the startup validator without
// a different invalid field hiding it. Never used to start a server or pay.
const baseline = {
  PAY_TO: "0x0000000000000000000000000000000000000001",
  UPSTREAM_URL: "https://upstream.example",
};
const checks: Record<string, string> = {
  PAY_TO: "Set a nonzero 0x-prefixed, 40-hex-digit receiving address.",
  KITE_NETWORK:
    "Use mainnet, testnet, 2366, 2368, or the corresponding eip155 identifier.",
  PRICE_USD:
    "Use a positive decimal with at most six fractional digits (optional $ prefix).",
  UPSTREAM_URL:
    "Set an HTTPS origin without credentials, path, query or fragment; localhost HTTP is allowed.",
  FACILITATOR_URL:
    "Use an HTTPS URL without credentials, query or fragment; localhost HTTP is allowed. Keep the service API path.",
  UPSTREAM_AUTH_HEADER:
    "Use a valid non-reserved application authentication header name.",
  UPSTREAM_AUTH_VALUE:
    "Remove embedded CR, LF or NUL characters from the credential.",
  PORT: "Use an integer from 1 to 65535.",
  UPSTREAM_TIMEOUT_MS: "Use an integer from 1 to 120000 milliseconds.",
  MAX_BODY_BYTES: "Use an integer from 1 to 16777216 bytes.",
  MAX_CONCURRENT_REQUESTS: "Use an integer from 1 to 10000.",
  FACILITATOR_TIMEOUT_MS: "Use an integer from 1 to 300000 milliseconds.",
  SHUTDOWN_TIMEOUT_MS: "Use an integer from 1 to 60000 milliseconds.",
  CORS_ORIGIN: "Use * or an HTTP(S) origin accepted by startup configuration.",
  RATE_LIMIT_RPS: "Use an integer from 1 to 100000, or leave unset to disable.",
  RATE_LIMIT_BURST:
    "Use an integer from 1 to 100000, or leave unset for the default.",
  FIREWALL_ALLOWLIST: "Use comma-separated IPv4, IPv6 or valid CIDR rules.",
  FIREWALL_BLOCKLIST: "Use comma-separated IPv4, IPv6 or valid CIDR rules.",
  TRUSTED_PROXY_CIDRS:
    "Use comma-separated trusted proxy IP addresses or CIDR rules.",
};

/** Offline, read-only checks. Never returns raw configuration or exception text. */
export function checkConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigPreflightReport {
  const report: ConfigPreflightReport = {
    ok: false,
    scope: "configuration-only",
    errors: [],
    warnings: [],
  };
  for (const [field, message] of Object.entries(checks)) {
    try {
      loadConfig({ ...baseline, [field]: env[field] });
    } catch {
      report.errors.push({ field, message });
    }
  }
  if (report.errors.length) return report;
  try {
    // Final validation of the actual combination guards against interactions and
    // future startup rules not yet covered by the isolated diagnostic list.
    const config = loadConfig(env);
    report.summary = {
      network: config.chain.network,
      asset: config.chain.symbol,
      priceAtomic: parsePrice(config.price, config.chain).amount,
    };
    if (!env.KITE_NETWORK?.trim())
      report.warnings.push({
        field: "KITE_NETWORK",
        message:
          "Network is unset: startup defaults to Kite mainnet. Select testnet explicitly for development.",
      });
    if (config.trustProxyHeaders && !config.trustedProxyCidrs?.length)
      report.warnings.push({
        field: "TRUST_PROXY_HEADERS",
        message:
          "Forwarded claims are trusted without peer CIDR restrictions; use an isolated ingress that replaces client headers.",
      });
    if (config.rateLimitBurst && !config.rateLimitRps)
      report.warnings.push({
        field: "RATE_LIMIT_BURST",
        message:
          "Burst is configured but RATE_LIMIT_RPS is unset; built-in rate limiting is disabled.",
      });
    if (config.maintenanceMode)
      report.warnings.push({
        field: "MAINTENANCE_MODE",
        message:
          "Maintenance mode is enabled: paid routes and readiness return 503.",
      });
    report.ok = true;
  } catch {
    report.errors.push({
      field: "CONFIG",
      message:
        "Combined configuration failed startup validation. Check the documented configuration contract.",
    });
  }
  return report;
}

export function formatConfigPreflight(report: ConfigPreflightReport): string {
  return [
    report.ok ? "Configuration check passed." : "Configuration check failed.",
    ...report.errors.map((e) => `ERROR ${e.field}: ${e.message}`),
    ...report.warnings.map((e) => `WARNING ${e.field}: ${e.message}`),
    ...(report.summary
      ? [
          `Kite network: ${report.summary.network}; asset: ${report.summary.asset}; atomic price: ${report.summary.priceAtomic}`,
        ]
      : []),
    "Offline configuration only; upstream reachability, wallet ownership, facilitator support and settlement are not verified.",
  ].join("\n");
}
