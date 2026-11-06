import { EventEmitter } from "node:events";

export interface SettlementEvent {
  payer: string;
  /** Atomic units; use bigint/string for values above Number.MAX_SAFE_INTEGER. */
  amount: bigint | string | number;
  txHash: string;
}

/** Synchronous in-process notifications; listener exceptions propagate to caller. */
export class SettlementBus extends EventEmitter {
  public emitSettlement(event: SettlementEvent): boolean {
    if (
      !event.payer ||
      !event.txHash ||
      (typeof event.amount === "number" &&
        !Number.isSafeInteger(event.amount)) ||
      (typeof event.amount === "string" && !/^\d+$/.test(event.amount)) ||
      BigInt(event.amount) < 0n
    )
      throw new Error("Invalid settlement event");
    return this.emit("settlement", Object.freeze({ ...event }));
  }
}
