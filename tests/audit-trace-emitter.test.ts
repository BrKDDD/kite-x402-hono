import { describe, it, expect } from "bun:test";
import { AuditTraceEmitter } from "../src/audit-trace-emitter.js";

describe("AuditTraceEmitter", () => {
  it("emits and formats structured compliance traces", () => {
    const emitter = new AuditTraceEmitter(10);
    const trace = emitter.emit({
      traceId: "trace-xyz",
      eventType: "PAYMENT_SETTLED",
      payerAddress: "0xAgent",
      amountUnits: "500000",
      latencyMs: 42,
    });

    expect(trace.timestamp).toBeDefined();
    expect(trace.traceId).toBe("trace-xyz");
    expect(emitter.getTraces().length).toBe(1);
  });

  it("bounds in-memory traces to configured maximum", () => {
    const emitter = new AuditTraceEmitter(2);
    emitter.emit({ traceId: "t1", eventType: "PAYMENT_AUTH", latencyMs: 10 });
    emitter.emit({ traceId: "t2", eventType: "PAYMENT_AUTH", latencyMs: 10 });
    emitter.emit({ traceId: "t3", eventType: "PAYMENT_AUTH", latencyMs: 10 });

    expect(emitter.getTraces().length).toBe(2);
    expect(emitter.getTraces()[0]?.traceId).toBe("t2");
  });
});
