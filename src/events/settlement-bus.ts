import { EventEmitter } from 'events';

export interface SettlementEvent {
  payer: string;
  amount: number;
  txHash: string;
}

export class SettlementBus extends EventEmitter {
  public emitSettlement(event: SettlementEvent) {
    this.emit('settlement', event);
  }
}
