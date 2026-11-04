/**
 * Structured Compliance Audit Trail and Latency Trace Emitter
 * Records in-memory diagnostic traces (not tamper-evident audit proofs) for payment authorizations and facilitator requests.
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
    if (!Number.isSafeInteger(maxTraces) || maxTraces < 1)
      throw new Error("Invalid trace limit");
    this.maxTraces = maxTraces;
  }

  public emit(event: Omit<AuditEventTrace, "timestamp">): AuditEventTrace {
    const fullEvent: AuditEventTrace = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    this.traces.push(structuredClone(fullEvent));
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    return fullEvent;
  }

  public getTraces(): readonly AuditEventTrace[] {
    return structuredClone(this.traces);
  }

  public clear(): void {
    this.traces = [];
  }
}
