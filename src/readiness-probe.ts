/**
 * Facilitator and upstream deep readiness probe for high-availability x402 services.
 * Probes the Kite facilitator and upstream API connectivity with TTL caching,
 * latency measurement, and health aggregation to prevent probe stampedes.
 */

export interface ProbeTarget {
  name: string;
  url: string;
  timeoutMs?: number;
}

export interface TargetHealth {
  name: string;
  healthy: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}

export interface ReadinessSnapshot {
  status: "UP" | "DEGRADED" | "DOWN";
  timestamp: number;
  cached: boolean;
  targets: Record<string, TargetHealth>;
}

export interface ReadinessProbeOptions {
  /** How long to cache probe results in milliseconds to prevent hammering remotes. Default: 5,000ms */
  cacheTtlMs?: number;
  /** Request timeout for individual target probes in milliseconds. Default: 3,000ms */
  timeoutMs?: number;
}

export class ReadinessProbe {
  private lastSnapshot: ReadinessSnapshot | null = null;
  private readonly cacheTtlMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly targets: ProbeTarget[] = [];

  constructor(options: ReadinessProbeOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000;
    this.defaultTimeoutMs = options.timeoutMs ?? 3_000;
  }

  addTarget(target: ProbeTarget): this {
    this.targets.push(target);
    return this;
  }

  private async probeTarget(target: ProbeTarget): Promise<TargetHealth> {
    const timeout = target.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(target.url, {
        method: "HEAD",
        signal: controller.signal,
      }).catch(async () => {
        // Fallback to GET if HEAD method is disallowed
        return await fetch(target.url, {
          method: "GET",
          signal: controller.signal,
        });
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      // Status codes < 500 indicate the service is responsive (even 402/404 proves connectivity)
      const healthy = response.status < 500;
      return {
        name: target.name,
        healthy,
        latencyMs,
        statusCode: response.status,
      };
    } catch (err) {
      return {
        name: target.name,
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async check(force: boolean = false): Promise<ReadinessSnapshot> {
    const now = Date.now();

    if (
      !force &&
      this.lastSnapshot &&
      now - this.lastSnapshot.timestamp < this.cacheTtlMs
    ) {
      return {
        ...this.lastSnapshot,
        cached: true,
      };
    }

    const results = await Promise.all(
      this.targets.map((t) => this.probeTarget(t)),
    );
    const targetMap: Record<string, TargetHealth> = {};
    let allHealthy = true;
    let anyHealthy = false;

    for (const res of results) {
      targetMap[res.name] = res;
      if (res.healthy) {
        anyHealthy = true;
      } else {
        allHealthy = false;
      }
    }

    let status: "UP" | "DEGRADED" | "DOWN" = "UP";
    if (this.targets.length > 0) {
      if (allHealthy) {
        status = "UP";
      } else if (anyHealthy) {
        status = "DEGRADED";
      } else {
        status = "DOWN";
      }
    }

    const snapshot: ReadinessSnapshot = {
      status,
      timestamp: now,
      cached: false,
      targets: targetMap,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }
}
