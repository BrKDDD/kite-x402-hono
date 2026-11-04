import { describe, it, expect } from "bun:test";
import { PrometheusMetricsExporter } from "../src/prometheus-metrics.js";

describe("PrometheusMetricsExporter", () => {
  it("tracks counters and produces OpenMetrics format output", () => {
    const exporter = new PrometheusMetricsExporter();
    exporter.incPaymentRequired();
    exporter.incPaymentRequired();
    exporter.incPaymentVerified(true);
    exporter.incPaymentVerified(false); // failure
    exporter.incPaymentSettled(10_000_000n, true);
    exporter.observeLatency(150);
    exporter.observeLatency(250);

    const text = exporter.toPrometheusString();
    expect(text).toContain("x402_payments_required_total 2");
    expect(text).toContain("x402_payments_verified_total 2");
    expect(text).toContain("x402_verification_failures_total 1");
    expect(text).toContain("x402_payments_settled_total 1");
    expect(text).toContain("x402_settled_volume_atomic_total 10000000");
    expect(text).toContain("x402_avg_latency_milliseconds 200.00");
  });

  it("returns structured metrics snapshot", () => {
    const exporter = new PrometheusMetricsExporter();
    exporter.incPaymentSettled(500n, true);
    exporter.incPaymentSettled(0n, false);

    const snapshot = exporter.getSnapshot();
    expect(snapshot.paymentsSettledTotal).toBe(1);
    expect(snapshot.settleFailuresTotal).toBe(1);
    expect(snapshot.settledVolumeAtomic).toBe(500n);
  });
});
