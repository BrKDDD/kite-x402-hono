import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkConfig } from "./config-preflight.js";
import { probeService } from "./service-probe.js";
import { checkPaymentChallenge } from "./payment-challenge.js";
import { KITE_NETWORKS } from "./networks.js";

export interface LocalAcceptanceReport {
  ok: boolean;
  scope: "local-simulation-only";
  checks: { name: string; ok: boolean }[];
  paymentCalls: { verify: number; upstream: number; settle: number };
}

/** Repeatable local HTTP acceptance; no environment, wallets or external services.
 * The simulated facilitator refuses all payment operations.
 */
export async function runLocalAcceptance(): Promise<LocalAcceptanceReport> {
  const checks: LocalAcceptanceReport["checks"] = [];
  const paymentCalls = { verify: 0, upstream: 0, settle: 0 };
  const env = {
    PAY_TO: "0x1234567890123456789012345678901234567890",
    KITE_NETWORK: "testnet",
    PRICE_USD: "0.001",
    UPSTREAM_URL: "http://127.0.0.1:1",
    FACILITATOR_URL: "http://127.0.0.1:1",
    LOG_ENABLED: "false",
  };
  const record = (name: string, ok: boolean) => checks.push({ name, ok });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const preflight = checkConfig(env);
    record("valid_configuration", preflight.ok);
    const invalid = checkConfig({ ...env, PAY_TO: "invalid" });
    record(
      "invalid_configuration_rejected",
      !invalid.ok && invalid.errors.some((e) => e.field === "PAY_TO"),
    );
    const app = createApp(loadConfig(env), {
      facilitator: {
        getSupported: async () => ({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: KITE_NETWORKS.testnet.network,
            },
          ],
          extensions: [],
          signers: {},
        }),
        verify: async () => {
          paymentCalls.verify++;
          throw new Error("Simulation forbids verification");
        },
        settle: async () => {
          paymentCalls.settle++;
          throw new Error("Simulation forbids settlement");
        },
      },
      fetchUpstream: async () => {
        paymentCalls.upstream++;
        throw new Error("Simulation forbids upstream delivery");
      },
      logSink: () => {},
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const origin = server.url.origin;
    const probe = await probeService({
      origin,
      expectedNetwork: "testnet",
      timeoutMs: 2000,
    });
    for (const result of probe.checks)
      record(`service:${result.path}`, result.ok);
    const mismatch = await probeService({
      origin,
      expectedNetwork: "mainnet",
      timeoutMs: 2000,
    });
    record(
      "wrong_network_rejected",
      !mismatch.ok &&
        mismatch.checks.every((c) => c.code === "network_mismatch"),
    );
    const policy = {
      url: `${origin}/v1/echo`,
      expectedNetwork: "testnet",
      expectedAmount: "1000000000000000",
      expectedPayTo: env.PAY_TO,
      timeoutMs: 2000,
    };
    const challenge = await checkPaymentChallenge(policy);
    record(
      "unpaid_challenge_matches",
      challenge.ok && challenge.status === 402,
    );
    const wrongAmount = await checkPaymentChallenge({
      ...policy,
      expectedAmount: "1",
    });
    record(
      "wrong_amount_rejected",
      !wrongAmount.ok && wrongAmount.code === "amount_mismatch",
    );
    const wrongRecipient = await checkPaymentChallenge({
      ...policy,
      expectedPayTo: "0x0000000000000000000000000000000000000001",
    });
    record(
      "wrong_recipient_rejected",
      !wrongRecipient.ok && wrongRecipient.code === "recipient_mismatch",
    );
  } catch {
    // Never include raw exception messages or local configuration in evidence.
    record("acceptance_execution", false);
  } finally {
    if (server) {
      try {
        await server.stop(true);
      } catch {
        record("server_cleanup", false);
      }
    }
  }
  record(
    "no_payment_operations",
    Object.values(paymentCalls).every((count) => count === 0),
  );
  return {
    ok: checks.every((check) => check.ok),
    scope: "local-simulation-only",
    checks,
    paymentCalls,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) {
    console.error("Usage: bun dist/local-acceptance.js [--json]");
    process.exitCode = 1;
  } else {
    const report = await runLocalAcceptance();
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : [
            "Local simulation only — no wallet, payment or on-chain settlement.",
            ...report.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
            report.ok ? "Local acceptance passed." : "Local acceptance failed.",
          ].join("\n"),
    );
    process.exitCode = report.ok ? 0 : 1;
  }
}
