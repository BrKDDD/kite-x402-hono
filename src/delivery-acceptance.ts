import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { PaymentNonceReplayGuard } from "./nonce-guard.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const scenarios = [
  "unpaid",
  "invalid_payment",
  "success",
  "upstream_failure",
  "settlement_refused",
] as const;
type Scenario = (typeof scenarios)[number];
export interface DeliveryAcceptanceReport {
  ok: boolean;
  scope: "simulated-delivery-only";
  retries: {
    name: "cached_success" | "upstream_recovery" | "refused_nonce";
    ok: boolean;
    statuses: number[];
    events: string[];
  }[];
  scenarios: {
    name: Scenario;
    ok: boolean;
    status?: number;
    events: string[];
  }[];
}

/** Local synthetic fixtures only. No cryptographic verification or chain calls. */
export async function runDeliveryAcceptance(): Promise<DeliveryAcceptanceReport> {
  const retries: DeliveryAcceptanceReport["retries"] = [];
  const results: DeliveryAcceptanceReport["scenarios"] = [];
  for (const name of scenarios) {
    const events: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    let status: number | undefined;
    let ok = false;
    let recovered = false;
    try {
      const config = loadConfig({
        PAY_TO: "0x1234567890123456789012345678901234567890",
        KITE_NETWORK: "testnet",
        PRICE_USD: "0.001",
        UPSTREAM_URL: "http://127.0.0.1:1",
        FACILITATOR_URL: "http://127.0.0.1:1",
        LOG_ENABLED: "false",
      });
      const payer = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const app = createApp(config, {
        nonceGuard: new PaymentNonceReplayGuard(),
        facilitator: {
          getSupported: async () => ({
            kinds: [
              {
                x402Version: 2,
                scheme: "exact",
                network: config.chain.network,
              },
            ],
            extensions: [],
            signers: {},
          }),
          verify: async () => {
            events.push("verify");
            return name === "invalid_payment"
              ? { isValid: false, invalidReason: "synthetic_rejection" }
              : { isValid: true, payer };
          },
          settle: async () => {
            events.push("settle");
            return {
              success: name !== "settlement_refused",
              transaction:
                name === "settlement_refused"
                  ? ""
                  : "simulation-not-a-chain-transaction",
              network: config.chain.network,
              payer,
              ...(name === "settlement_refused"
                ? { errorReason: "synthetic_rejection" }
                : {}),
            };
          },
        },
        fetchUpstream: async () => {
          events.push("upstream");
          return name === "upstream_failure" && !recovered
            ? Response.json(
                { error: "synthetic_upstream_failure" },
                { status: 503 },
              )
            : Response.json({ result: "synthetic-protected-content" });
        },
        logSink: () => {},
      });
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      const url = `${server.url}v1/echo`;
      const request = (headers?: HeadersInit) =>
        fetch(url, {
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.timeout(2000),
          ...(headers ? { headers } : {}),
        });
      let response = await request();
      const encoded = response.headers.get("payment-required");
      if (response.status !== 402 || !encoded || events.length)
        throw new Error("Invalid initial challenge");
      await response.body?.cancel();
      if (name === "unpaid") {
        status = 402;
        ok = true;
      } else {
        const challenge = JSON.parse(
          Buffer.from(encoded, "base64").toString(),
        ) as PaymentRequired;
        const accepted = challenge.accepts[0];
        if (!accepted) throw new Error("Missing requirements");
        // Deliberately invalid cryptographic signature, accepted only by this isolated stub.
        const payload: PaymentPayload = {
          x402Version: 2,
          accepted,
          payload: {
            signature: "0xfixture",
            authorization: {
              from: payer,
              to: config.payTo,
              value: accepted.amount,
              validAfter: "0",
              validBefore: "9999999999",
              nonce: `0x${"00".repeat(32)}`,
            },
          },
        };
        const paidHeaders = {
          "idempotency-key": "synthetic-delivery-retry",
          "payment-signature": Buffer.from(JSON.stringify(payload)).toString(
            "base64",
          ),
        };
        response = await request(paidHeaders);
        status = response.status;
        const body = await response.text();
        const expectedEvents =
          name === "invalid_payment"
            ? ["verify"]
            : name === "upstream_failure"
              ? ["verify", "upstream"]
              : ["verify", "upstream", "settle"];
        const expectedStatus =
          name === "success" ? 200 : name === "upstream_failure" ? 503 : 402;
        ok =
          status === expectedStatus &&
          JSON.stringify(events) === JSON.stringify(expectedEvents);
        if (name === "success") {
          const receipt = response.headers.get("payment-response");
          const settlement = receipt
            ? JSON.parse(Buffer.from(receipt, "base64").toString())
            : null;
          ok &&=
            body ===
              JSON.stringify({ result: "synthetic-protected-content" }) &&
            settlement?.success === true &&
            settlement.transaction === "simulation-not-a-chain-transaction" &&
            !!response.headers.get("cache-control")?.includes("no-store");
        } else {
          ok &&= !body.includes("synthetic-protected-content");
          if (name === "upstream_failure")
            ok &&= !response.headers.has("payment-response");
        }
        if (
          name === "success" ||
          name === "upstream_failure" ||
          name === "settlement_refused"
        ) {
          const before = [...events];
          recovered = true;
          const retry = await request(paidHeaders);
          const retryBody = await retry.text();
          const statuses = [status, retry.status];
          let retryOk: boolean;
          if (name === "settlement_refused") {
            retryOk =
              retry.status === 402 &&
              !retryBody.includes("synthetic-protected-content") &&
              !retry.headers.has("idempotent-replayed") &&
              JSON.stringify(events) === JSON.stringify(before);
          } else {
            const receipt = retry.headers.get("payment-response");
            retryOk =
              retry.status === 200 &&
              retryBody ===
                JSON.stringify({ result: "synthetic-protected-content" }) &&
              !!receipt;
            if (name === "success") {
              retryOk &&=
                retry.headers.get("idempotent-replayed") === "true" &&
                receipt === response.headers.get("payment-response") &&
                JSON.stringify(events) === JSON.stringify(before);
            } else {
              retryOk &&=
                !retry.headers.has("idempotent-replayed") &&
                JSON.stringify(events) ===
                  JSON.stringify([...before, "verify", "upstream", "settle"]);
              const afterRecovery = [...events];
              const replay = await request(paidHeaders);
              statuses.push(replay.status);
              retryOk &&=
                replay.status === 200 &&
                replay.headers.get("idempotent-replayed") === "true" &&
                replay.headers.get("payment-response") === receipt;
              const replayBody = await replay.text();
              retryOk &&=
                replayBody === retryBody &&
                JSON.stringify(events) === JSON.stringify(afterRecovery);
            }
          }
          retries.push({
            name:
              name === "success"
                ? "cached_success"
                : name === "upstream_failure"
                  ? "upstream_recovery"
                  : "refused_nonce",
            ok: retryOk,
            statuses,
            events: [...events],
          });
          ok &&= retryOk;
          // Preserve the initial attempt's trace in the original scenario report.
          events.splice(0, events.length, ...before);
        }
      }
    } catch {
      ok = false;
    } finally {
      if (server) {
        try {
          await server.stop(true);
        } catch {
          ok = false;
        }
      }
    }
    results.push({
      name,
      ok,
      ...(status === undefined ? {} : { status }),
      events,
    });
  }
  return {
    ok:
      results.every((r) => r.ok) &&
      retries.length === 3 &&
      retries.every((r) => r.ok),
    retries,
    scope: "simulated-delivery-only",
    scenarios: results,
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    console.error("Usage: bun dist/delivery-acceptance.js [--json]");
    process.exitCode = 1;
  } else {
    const report = await runDeliveryAcceptance();
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(report)
        : [
            "SIMULATED delivery only; no real signature verification or on-chain settlement.",
            ...report.retries.map(
              (r) =>
                `${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.statuses.join(" -> ")}`,
            ),
            ...report.scenarios.map(
              (s) =>
                `${s.ok ? "PASS" : "FAIL"} ${s.name}: ${s.events.join(" -> ") || "no payment calls"}`,
            ),
          ].join("\n"),
    );
    process.exitCode = report.ok ? 0 : 1;
  }
}
