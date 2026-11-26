import { expect, test } from "bun:test";
import {
  summarizeAcceptance,
  formatAcceptanceEvidence,
  runAcceptanceReport,
} from "../src/acceptance-report.js";
import { runLocalAcceptance } from "../src/local-acceptance.js";
import { runDeliveryAcceptance } from "../src/delivery-acceptance.js";
const fixtures = async () =>
  Promise.all([runLocalAcceptance(), runDeliveryAcceptance()]);
test("combined report requires all eighteen checks and explicit simulation scope", async () => {
  const r = await runAcceptanceReport();
  expect(r.ok).toBe(true);
  expect(r.checks).toHaveLength(18);
  expect(r.scope).toBe("local-simulation-only");
  expect(formatAcceptanceEvidence(r)).toContain(
    "No real cryptographic verification",
  );
});
test("missing, duplicate, false and nonboolean results cannot be counted as passes", async () => {
  const [l, d] = await fixtures();
  for (const checks of [
    l.checks.slice(1),
    [...l.checks, l.checks[0]],
    l.checks.map((c, i) => (i === 0 ? { ...c, ok: "true" } : c)),
    l.checks.map((c, i) => (i === 0 ? { ...c, ok: false } : c)),
  ])
    expect(summarizeAcceptance({ ...l, checks }, d).ok).toBe(false);
  expect(summarizeAcceptance(l, { ...d, retries: [] }).ok).toBe(false);
  expect(
    summarizeAcceptance(
      { ...l, paymentCalls: { verify: 1, upstream: 0, settle: 0 } },
      d,
    ).ok,
  ).toBe(false);
  expect(summarizeAcceptance(l, { ...d, scope: "on-chain" }).ok).toBe(false);
  expect(summarizeAcceptance(l, { ...d, ok: false }).ok).toBe(false);
});
test("only fixed identifiers and booleans survive untrusted extra fields", async () => {
  const [l, d] = await fixtures();
  const secret = "SECRET-wallet-signature-url";
  const r = summarizeAcceptance(
    { ...l, secret, checks: l.checks.map((c) => ({ ...c, secret })) },
    { ...d, secret },
  );
  expect(r.ok).toBe(true);
  expect(JSON.stringify(r)).not.toContain(secret);
  expect(formatAcceptanceEvidence(r)).not.toContain(secret);
  const bad = summarizeAcceptance(
    { ...l, checks: [{ name: secret, ok: true }] },
    d,
  );
  expect(bad.ok).toBe(false);
  expect(formatAcceptanceEvidence(bad)).not.toContain(secret);
});
test("invalid inputs produce fixed failed evidence", () => {
  for (const value of [null, undefined, [], "secret", {}]) {
    const r = summarizeAcceptance(value, value);
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(18);
  }
});

test("failure reasons distinguish missing duplicate malformed and failed checks", async () => {
  const [l, d] = await fixtures();
  const cases = [
    { checks: l.checks.slice(1), reason: "missing" },
    { checks: [...l.checks, l.checks[0]], reason: "duplicate" },
    {
      checks: l.checks.map((c, i) => (i === 0 ? { ...c, ok: "SECRET" } : c)),
      reason: "invalid_result",
    },
    {
      checks: l.checks.map((c, i) => (i === 0 ? { ...c, ok: false } : c)),
      reason: "assertion_failed",
    },
  ] as const;
  for (const c of cases) {
    const r = summarizeAcceptance({ ...l, checks: c.checks }, d);
    expect(r.checks[0]?.reason).toBe(c.reason);
    expect(formatAcceptanceEvidence(r)).toContain("Troubleshooting:");
    expect(formatAcceptanceEvidence(r)).not.toContain("SECRET");
  }
  expect(
    summarizeAcceptance(l, d).checks.every((c) => c.reason === "passed"),
  ).toBe(true);
  expect(formatAcceptanceEvidence(summarizeAcceptance(l, d))).not.toContain(
    "Troubleshooting:",
  );
});
test("suite failure retains guidance even when individual checks pass", async () => {
  const [l, d] = await fixtures();
  const r = summarizeAcceptance(l, { ...d, ok: false });
  expect(r.checks.every((c) => c.ok)).toBe(true);
  expect(r.ok).toBe(false);
  expect(formatAcceptanceEvidence(r)).toContain(
    "If all checks pass but a suite fails",
  );
});
