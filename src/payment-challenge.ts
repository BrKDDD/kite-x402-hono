import { resolveNetwork } from "./networks.js";

export interface PaymentChallengeOptions {
  url: string;
  expectedNetwork: string;
  /** Exact positive atomic token amount, not a decimal USD price. */
  expectedAmount: string;
  expectedPayTo: string;
  timeoutMs?: number;
}
export type PaymentChallengeCode =
  | "ok"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "not_payment_required"
  | "missing_header"
  | "invalid_challenge"
  | "protocol_mismatch"
  | "network_mismatch"
  | "asset_mismatch"
  | "amount_mismatch"
  | "recipient_mismatch";
export interface PaymentChallengeReport {
  ok: boolean;
  scope: "unpaid-challenge-only";
  code: PaymentChallengeCode;
  status?: number;
  /** Each advertised alternative is checked independently. */
  alternatives: { index: number; code: PaymentChallengeCode }[];
  matchedIndex?: number;
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const amount = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9]\d{0,77}$/.test(v) && BigInt(v) < 1n << 256n;
const address = (v: unknown): v is string =>
  typeof v === "string" &&
  /^0x[\da-fA-F]{40}$/.test(v) &&
  !/^0x0{40}$/i.test(v);

/** Inspect an operator-supplied paid GET endpoint without signing or paying.
 * Do not expose this operator tool as an arbitrary-URL public endpoint.
 */
export async function checkPaymentChallenge(
  options: PaymentChallengeOptions,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<PaymentChallengeReport> {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("Supply a valid HTTP(S) payment endpoint URL.");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Use HTTPS without credentials or fragment; localhost HTTP is allowed.",
    );
  const chain = resolveNetwork(options.expectedNetwork);
  if (!chain)
    throw new Error("Select an expected Kite mainnet or testnet network.");
  if (!amount(options.expectedAmount))
    throw new Error(
      "Expected amount must be a canonical positive uint256 atomic amount.",
    );
  if (!address(options.expectedPayTo))
    throw new Error("Expected recipient must be a nonzero EVM address.");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error("Challenge timeout must be 1–300000 milliseconds.");
  // Snapshot policy before awaiting remote input.
  const expectedAmount = options.expectedAmount;
  const expectedPayTo = options.expectedPayTo.toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  const alternatives: PaymentChallengeReport["alternatives"] = [];
  const report = (
    code: PaymentChallengeCode,
    matchedIndex?: number,
  ): PaymentChallengeReport => ({
    ok: code === "ok",
    scope: "unpaid-challenge-only",
    code,
    ...(response ? { status: response.status } : {}),
    alternatives,
    ...(matchedIndex === undefined ? {} : { matchedIndex }),
  });
  try {
    response = await fetchFn(url.href, {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400)
      return report("redirect");
    if (response.status !== 402) return report("not_payment_required");
    const header = response.headers.get("payment-required");
    if (!header) return report("missing_header");
    // Bound decoded input and reject permissive Buffer base64 decoding aliases.
    if (
      header.length > 65536 ||
      header.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        header,
      )
    )
      return report("invalid_challenge");
    const bytes = Buffer.from(header, "base64");
    if (bytes.toString("base64") !== header) return report("invalid_challenge");
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!object(body)) return report("invalid_challenge");
    if (body.x402Version !== 2) return report("protocol_mismatch");
    if (
      !Array.isArray(body.accepts) ||
      body.accepts.length === 0 ||
      body.accepts.length > 100
    )
      return report("invalid_challenge");
    for (const [index, entry] of body.accepts.entries()) {
      let code: PaymentChallengeCode;
      if (
        !object(entry) ||
        !amount(entry.amount) ||
        !address(entry.payTo) ||
        typeof entry.asset !== "string" ||
        !/^0x[\da-fA-F]{40}$/.test(entry.asset) ||
        typeof entry.network !== "string" ||
        !Number.isSafeInteger(entry.maxTimeoutSeconds) ||
        (entry.maxTimeoutSeconds as number) <= 0
      )
        code = "invalid_challenge";
      else if (entry.scheme !== "exact") code = "protocol_mismatch";
      else if (entry.network !== chain.network) code = "network_mismatch";
      else if (entry.asset.toLowerCase() !== chain.asset.toLowerCase())
        code = "asset_mismatch";
      else if (entry.amount !== expectedAmount) code = "amount_mismatch";
      else if (entry.payTo.toLowerCase() !== expectedPayTo)
        code = "recipient_mismatch";
      else code = "ok";
      alternatives.push({ index, code });
    }
    const match = alternatives.find((entry) => entry.code === "ok");
    return match ? report("ok", match.index) : report(alternatives[0]!.code);
  } catch {
    return report(
      controller.signal.aborted
        ? "timeout"
        : response
          ? "invalid_challenge"
          : "unreachable",
    );
  } finally {
    clearTimeout(timer);
    // The response body is unnecessary; do not wait for remote cancellation.
    void response?.body?.cancel().catch(() => {});
  }
}

export function formatPaymentChallenge(report: PaymentChallengeReport): string {
  return [
    report.ok
      ? "Payment challenge checks passed."
      : "Payment challenge checks failed.",
    `Result: ${report.code}${report.status ? ` (HTTP ${report.status})` : ""}`,
    ...report.alternatives.map((a) => `Alternative ${a.index}: ${a.code}`),
    "No payment was signed or sent. This does not prove wallet ownership or successful settlement.",
  ].join("\n");
}
