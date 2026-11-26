import { resolveNetwork, type KiteNetwork } from "./networks.js";
import { readLimited } from "./proxy.js";

export interface ServiceProbeOptions {
  origin: string;
  expectedNetwork: string;
  /** Deadline per endpoint, including its body; default 5000, max 300000 ms. */
  timeoutMs?: number;
}
export type ServiceProbeCode =
  | "ok"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "http_error"
  | "invalid_response"
  | "network_mismatch"
  | "asset_mismatch"
  | "protocol_mismatch"
  | "maintenance_mode"
  | "facilitator_unavailable"
  | "network_not_offered";
export interface ServiceEndpointResult {
  path: string;
  ok: boolean;
  code: ServiceProbeCode;
  status?: number;
}
export interface ServiceProbeReport {
  ok: boolean;
  scope: "gateway-diagnostics-only";
  expectedNetwork: string;
  checks: ServiceEndpointResult[];
}
type FetchProbe = (url: string, init: RequestInit) => Promise<Response>;
const paths = ["/healthz", "/readyz", "/.well-known/x402"] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validate(
  path: string,
  body: unknown,
  chain: KiteNetwork,
  status: number,
): ServiceProbeCode {
  if (!object(body)) return "invalid_response";
  if (path === "/readyz" && status === 503 && body.ok === false) {
    if (
      body.error === "maintenance_mode" ||
      body.error === "facilitator_unavailable" ||
      body.error === "network_not_offered"
    )
      return body.error;
  }
  if (status !== 200) return "http_error";
  if (typeof body.network !== "string") return "invalid_response";
  if (body.network !== chain.network) return "network_mismatch";
  if (path !== "/.well-known/x402") {
    if (body.ok !== true) return "invalid_response";
    return body.asset === chain.symbol ? "ok" : "asset_mismatch";
  }
  if (body.x402Version !== 2 || body.scheme !== "exact")
    return "protocol_mismatch";
  if (!object(body.asset) || typeof body.asset.address !== "string")
    return "invalid_response";
  if (
    body.asset.address.toLowerCase() !== chain.asset.toLowerCase() ||
    body.asset.decimals !== chain.decimals
  )
    return "asset_mismatch";
  if (
    !object(body.pricing) ||
    typeof body.pricing.atomicAmount !== "string" ||
    !/^\d{1,78}$/.test(body.pricing.atomicAmount) ||
    BigInt(body.pricing.atomicAmount) <= 0n ||
    BigInt(body.pricing.atomicAmount) >= 1n << 256n ||
    typeof body.pricing.payTo !== "string" ||
    !/^0x[\da-fA-F]{40}$/.test(body.pricing.payTo) ||
    /^0x0{40}$/i.test(body.pricing.payTo)
  )
    return "invalid_response";
  return "ok";
}

/** Read only the wrapper's three public endpoints, without credentials or redirects.
 * An operator-supplied target is required; do not expose this as an arbitrary-URL web endpoint.
 */
export async function probeService(
  options: ServiceProbeOptions,
  fetchFn: FetchProbe = fetch,
): Promise<ServiceProbeReport> {
  let url: URL;
  try {
    url = new URL(options.origin);
  } catch {
    throw new Error("Supply a valid service HTTP(S) origin.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Use an HTTPS origin without credentials, path, query or fragment; localhost HTTP is allowed.",
    );
  const chain = resolveNetwork(options.expectedNetwork);
  if (!chain)
    throw new Error("Select an expected Kite mainnet or testnet network.");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error("Probe timeout must be 1–300000 milliseconds.");
  const checks = await Promise.all(
    paths.map(async (path): Promise<ServiceEndpointResult> => {
      const controller = new AbortController();
      let expire!: () => void;
      const deadline = new Promise<never>((_, reject) => {
        expire = reject;
      });
      const timer = setTimeout(() => {
        controller.abort();
        expire();
      }, timeoutMs);
      let response: Response | undefined;
      let code: ServiceProbeCode;
      try {
        const pending = Promise.resolve(
          fetchFn(new URL(path, url.origin).href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          }),
        ).then((result) => {
          // The report may already be complete when a custom fetch returns.
          if (controller.signal.aborted)
            void result.body?.cancel().catch(() => {});
          return result;
        });
        response = await Promise.race([pending, deadline]);
        if (response.status >= 300 && response.status < 400) code = "redirect";
        else if (
          response.status !== 200 &&
          !(path === "/readyz" && response.status === 503)
        )
          code = "http_error";
        else {
          const bytes = await readLimited(
            response.body,
            65536,
            controller.signal,
          );
          code = validate(
            path,
            JSON.parse(new TextDecoder().decode(bytes)),
            chain,
            response.status,
          );
        }
      } catch {
        code = controller.signal.aborted
          ? "timeout"
          : response
            ? "invalid_response"
            : "unreachable";
      } finally {
        clearTimeout(timer);
        // Do not wait for a remote producer's cancellation to complete.
        void response?.body?.cancel().catch(() => {});
      }
      return {
        path,
        ok: code === "ok",
        code,
        ...(response ? { status: response.status } : {}),
      };
    }),
  );
  return {
    ok: checks.every((check) => check.ok),
    scope: "gateway-diagnostics-only",
    expectedNetwork: chain.network,
    checks,
  };
}

export function formatServiceProbe(report: ServiceProbeReport): string {
  return [
    report.ok ? "Service diagnostics passed." : "Service diagnostics failed.",
    `Expected Kite network: ${report.expectedNetwork}`,
    ...report.checks.map(
      (c) =>
        `${c.ok ? "PASS" : "FAIL"} ${c.path}: ${c.code}${c.status ? ` (HTTP ${c.status})` : ""}`,
    ),
    "These endpoint reports do not prove upstream readiness, wallet ownership or successful payment settlement.",
  ].join("\n");
}
