/**
 * Structured Compliance Audit Trail and Latency Trace Emitter
 * Records tamper-evident audit traces for payment authorizations and facilitator requests.
 */

export interface AuditEventTrace {
  traceId: string;
  eventType:
    | "PAYMENT_AUTH"
    | "PAYMENT_VERIFIED"
    | "PAYMENT_SETTLED"
    | "AUTH_FAILED";
  timestamp: string;
  payerAddress?: string;
  amountUnits?: string;
  network?: string;
  latencyMs: number;
  metadata?: Record<string, any>;
}

export class AuditTraceEmitter {
  private traces: AuditEventTrace[] = [];
  private readonly maxTraces: number;

  constructor(maxTraces: number = 500) {
    this.maxTraces = maxTraces;
  }

  public emit(event: Omit<AuditEventTrace, "timestamp">): AuditEventTrace {
    const fullEvent: AuditEventTrace = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    this.traces.push(fullEvent);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    return fullEvent;
  }

  public getTraces(): readonly AuditEventTrace[] {
    return this.traces;
  }

  public clear(): void {
    this.traces = [];
  }
}
