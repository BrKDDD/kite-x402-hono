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
    // 使用同一份快照校验和通知，避免 getter 重读或隐式数值转换改变事件含义。
    const snapshot = { ...event };
    if (
      typeof snapshot.payer !== "string" ||
      !snapshot.payer ||
      typeof snapshot.txHash !== "string" ||
      !snapshot.txHash ||
      !["bigint", "number", "string"].includes(typeof snapshot.amount) ||
      (typeof snapshot.amount === "number" &&
        !Number.isSafeInteger(snapshot.amount)) ||
      (typeof snapshot.amount === "string" && !/^\d+$/.test(snapshot.amount)) ||
      BigInt(snapshot.amount) < 0n
    )
      throw new Error("Invalid settlement event");
    return this.emit("settlement", Object.freeze(snapshot));
  }
}
