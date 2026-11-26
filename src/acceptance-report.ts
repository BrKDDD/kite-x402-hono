import { runLocalAcceptance } from "./local-acceptance.js";
import { runDeliveryAcceptance } from "./delivery-acceptance.js";

const names = {
  diagnostics: [
    "valid_configuration",
    "invalid_configuration_rejected",
    "service:/healthz",
    "service:/readyz",
    "service:/.well-known/x402",
    "wrong_network_rejected",
    "unpaid_challenge_matches",
    "wrong_amount_rejected",
    "wrong_recipient_rejected",
    "no_payment_operations",
  ],
  delivery: [
    "unpaid",
    "invalid_payment",
    "success",
    "upstream_failure",
    "settlement_refused",
  ],
  retries: ["cached_success", "upstream_recovery", "refused_nonce"],
} as const;
export type AcceptanceCheckReason =
  | "passed"
  | "missing"
  | "duplicate"
  | "invalid_result"
  | "assertion_failed";
export interface AcceptanceEvidence {
  schemaVersion: 1;
  scope: "local-simulation-only";
  ok: boolean;
  checks: {
    suite: "diagnostics" | "delivery" | "retries";
    name: string;
    ok: boolean;
    reason: AcceptanceCheckReason;
  }[];
  suites: { diagnostics: boolean; delivery: boolean };
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Project only known check identifiers and strict booleans. Never copy raw data.
 * Summarizes assertions, not an authenticated proof of execution.
 */
export function summarizeAcceptance(
  local: unknown,
  delivery: unknown,
): AcceptanceEvidence {
  const l = object(local) ? local : {};
  const d = object(delivery) ? delivery : {};
  const project = (suite: keyof typeof names, input: unknown) =>
    names[suite].map((name) => {
      const matching = Array.isArray(input)
        ? input.filter((item) => object(item) && item.name === name)
        : [];
      const reason: AcceptanceCheckReason =
        matching.length === 0
          ? "missing"
          : matching.length > 1
            ? "duplicate"
            : typeof matching[0].ok !== "boolean"
              ? "invalid_result"
              : matching[0].ok
                ? "passed"
                : "assertion_failed";
      return {
        reason,
        suite,
        name,
        ok: matching.length === 1 && matching[0].ok === true,
      };
    });
  const checks = [
    ...project("diagnostics", l.checks),
    ...project("delivery", d.scenarios),
    ...project("retries", d.retries),
  ];
  const calls = object(l.paymentCalls) ? l.paymentCalls : {};
  const suites = {
    diagnostics:
      l.ok === true &&
      l.scope === "local-simulation-only" &&
      calls.verify === 0 &&
      calls.upstream === 0 &&
      calls.settle === 0 &&
      checks.filter((c) => c.suite === "diagnostics").every((c) => c.ok) &&
      Array.isArray(l.checks) &&
      l.checks.length === names.diagnostics.length,
    delivery:
      d.ok === true &&
      d.scope === "simulated-delivery-only" &&
      checks.filter((c) => c.suite !== "diagnostics").every((c) => c.ok) &&
      Array.isArray(d.scenarios) &&
      d.scenarios.length === names.delivery.length &&
      Array.isArray(d.retries) &&
      d.retries.length === names.retries.length,
  };
  return {
    schemaVersion: 1,
    scope: "local-simulation-only",
    ok: suites.diagnostics && suites.delivery,
    suites,
    checks,
  };
}

export function formatAcceptanceEvidence(report: AcceptanceEvidence): string {
  return [
    "# Local simulated acceptance",
    "",
    `Result: ${report.ok ? "PASS" : "FAIL"}`,
    "",
    "Simulation only. No real cryptographic verification or on-chain transaction evidence.",
    "Nonce retry checks require the explicit in-memory guard; restart/distributed guarantees are not tested.",
    "",
    `Diagnostics suite: ${report.suites.diagnostics ? "PASS" : "FAIL"}`,
    `Delivery suite: ${report.suites.delivery ? "PASS" : "FAIL"}`,
    "",
    "| Suite | Check | Result | Reason |",
    "| --- | --- | --- | --- |",
    ...report.checks.map(
      (c) =>
        `| ${c.suite} | ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.reason} |`,
    ),
    "",
    ...(!report.ok
      ? [
          "Troubleshooting: rerun the failed suite with acceptance:local or acceptance:delivery.",
          "missing/duplicate/invalid_result: rebuild from a clean checkout and check runner/report compatibility.",
          "assertion_failed: inspect the named scenario in the detailed suite report; do not retry real payments blindly.",
          "If all checks pass but a suite fails, inspect its scope, overall result, cleanup and diagnostic payment-call counts.",
          "See docs/acceptance-troubleshooting.md. Share sanitized reports, not environment files or credentials.",
          "",
        ]
      : []),
    "This report summarizes local assertions; it is not signed proof or a registry release confirmation.",
    "",
  ].join("\n");
}

export async function runAcceptanceReport(): Promise<AcceptanceEvidence> {
  // Run both suites even when one rejects; reports omit exception details.
  const results = await Promise.allSettled([
    runLocalAcceptance(),
    runDeliveryAcceptance(),
  ]);
  return summarizeAcceptance(
    results[0].status === "fulfilled" ? results[0].value : undefined,
    results[1].status === "fulfilled" ? results[1].value : undefined,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) {
    console.error("Usage: bun dist/acceptance-report.js [--json]");
    process.exitCode = 1;
  } else {
    const report = await runAcceptanceReport();
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : formatAcceptanceEvidence(report),
    );
    process.exitCode = report.ok ? 0 : 1;
  }
}
