/**
 * Prometheus OpenMetrics Exporter for x402 payment wrappers.
 * Exposes standardized observability counters, volume metrics, and latency stats.
 */

export interface MetricsSnapshot {
  paymentsRequiredTotal: number;
  paymentsVerifiedTotal: number;
  paymentsSettledTotal: number;
  settledVolumeAtomic: bigint;
  verifyFailuresTotal: number;
  settleFailuresTotal: number;
  averageLatencyMs: number;
}

export class PrometheusMetricsExporter {
  private paymentsRequired = 0;
  private paymentsVerified = 0;
  private paymentsSettled = 0;
  private settledVolume = 0n;
  private verifyFailures = 0;
  private settleFailures = 0;
  private totalLatencyMs = 0;
  private latencyObservations = 0;

  public incPaymentRequired(): void {
    this.paymentsRequired += 1;
  }

  public incPaymentVerified(success: boolean): void {
    this.paymentsVerified += 1;
    if (!success) {
      this.verifyFailures += 1;
    }
  }

  public incPaymentSettled(amountAtomic: bigint, success: boolean): void {
    if (success) {
      this.paymentsSettled += 1;
      this.settledVolume += amountAtomic;
    } else {
      this.settleFailures += 1;
    }
  }

  public observeLatency(latencyMs: number): void {
    this.totalLatencyMs += latencyMs;
    this.latencyObservations += 1;
  }

  /**
   * Generates standard Prometheus text-format string.
   */
  public toPrometheusString(): string {
    const avgLatency =
      this.latencyObservations > 0
        ? this.totalLatencyMs / this.latencyObservations
        : 0;

    return (
      [
        "# HELP x402_payments_required_total Total 402 Payment Required challenges prompted",
        "# TYPE x402_payments_required_total counter",
        `x402_payments_required_total ${this.paymentsRequired}`,
        "# HELP x402_payments_verified_total Total payment verification attempts",
        "# TYPE x402_payments_verified_total counter",
        `x402_payments_verified_total ${this.paymentsVerified}`,
        "# HELP x402_payments_settled_total Total successfully settled payments",
        "# TYPE x402_payments_settled_total counter",
        `x402_payments_settled_total ${this.paymentsSettled}`,
        "# HELP x402_settled_volume_atomic_total Total settled volume in atomic units",
        "# TYPE x402_settled_volume_atomic_total counter",
        `x402_settled_volume_atomic_total ${this.settledVolume.toString()}`,
        "# HELP x402_verification_failures_total Total verification failures",
        "# TYPE x402_verification_failures_total counter",
        `x402_verification_failures_total ${this.verifyFailures}`,
        "# HELP x402_settlement_failures_total Total settlement failures",
        "# TYPE x402_settlement_failures_total counter",
        `x402_settlement_failures_total ${this.settleFailures}`,
        "# HELP x402_avg_latency_milliseconds Average latency of facilitator operations",
        "# TYPE x402_avg_latency_milliseconds gauge",
        `x402_avg_latency_milliseconds ${avgLatency.toFixed(2)}`,
      ].join("\n") + "\n"
    );
  }

  public getSnapshot(): MetricsSnapshot {
    return {
      paymentsRequiredTotal: this.paymentsRequired,
      paymentsVerifiedTotal: this.paymentsVerified,
      paymentsSettledTotal: this.paymentsSettled,
      settledVolumeAtomic: this.settledVolume,
      verifyFailuresTotal: this.verifyFailures,
      settleFailuresTotal: this.settleFailures,
      averageLatencyMs:
        this.latencyObservations > 0
          ? this.totalLatencyMs / this.latencyObservations
          : 0,
    };
  }

  public reset(): void {
    this.paymentsRequired = 0;
    this.paymentsVerified = 0;
    this.paymentsSettled = 0;
    this.settledVolume = 0n;
    this.verifyFailures = 0;
    this.settleFailures = 0;
    this.totalLatencyMs = 0;
    this.latencyObservations = 0;
  }
}
