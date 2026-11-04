/**
 * Multi-RPC Endpoint Failover and Circuit Breaker Manager
 * Coordinates endpoint health checks, consecutive error tripping, and automatic fallback.
 */

export interface RpcEndpoint {
  url: string;
  weight?: number;
  failureCount: number;
  lastFailureTime: number;
  isHealthy: boolean;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownPeriodMs: number;
}

export class RpcCircuitBreakerManager {
  private endpoints: RpcEndpoint[];
  private currentIndex: number = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(urls: string[], config?: Partial<CircuitBreakerConfig>) {
    if (urls.length === 0) throw new Error("At least one RPC URL is required");
    this.endpoints = urls.map((url) => ({
      url,
      failureCount: 0,
      lastFailureTime: 0,
      isHealthy: true,
    }));
    this.config = {
      failureThreshold: config?.failureThreshold ?? 3,
      cooldownPeriodMs: config?.cooldownPeriodMs ?? 30000,
    };
  }

  public getActiveEndpoint(now: number = Date.now()): string {
    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      if (!ep) continue;

      // Check if cooldown period elapsed
      if (
        !ep.isHealthy &&
        now - ep.lastFailureTime > this.config.cooldownPeriodMs
      ) {
        ep.isHealthy = true;
        ep.failureCount = 0;
      }

      if (ep.isHealthy) {
        this.currentIndex = i;
        return ep.url;
      }
    }

    // If all unhealthy, fallback to first endpoint
    return this.endpoints[0]?.url ?? "";
  }

  public recordSuccess(url: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) {
      ep.failureCount = 0;
      ep.isHealthy = true;
    }
  }

  public recordFailure(url: string, now: number = Date.now()): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep) return;

    ep.failureCount++;
    ep.lastFailureTime = now;

    if (ep.failureCount >= this.config.failureThreshold) {
      ep.isHealthy = false;
      this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    }
  }

  public getStatus() {
    return this.endpoints.map((e) => ({
      url: e.url,
      isHealthy: e.isHealthy,
      failures: e.failureCount,
    }));
  }
}
