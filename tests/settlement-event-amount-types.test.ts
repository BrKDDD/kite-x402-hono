import { expect, test } from "bun:test";
import {
  SettlementBus,
  type SettlementEvent,
} from "../src/events/settlement-bus.js";

const event = (amount: unknown): SettlementEvent => ({
  payer: "fixture-payer",
  txHash: "fixture-tx",
  amount: amount as SettlementEvent["amount"],
});

test("unsupported runtime amount types cannot reach settlement subscribers", () => {
  const bus = new SettlementBus();
  let deliveries = 0;
  bus.on("settlement", () => {
    deliveries++;
  });
  for (const amount of [
    true,
    false,
    [],
    [1],
    {},
    null,
    undefined,
    () => 1,
    new String("1"),
  ])
    expect(() => bus.emitSettlement(event(amount))).toThrow();
  expect(deliveries).toBe(0);
});

test("rejected objects never run user-defined numeric conversion", () => {
  const bus = new SettlementBus();
  let conversions = 0;
  const amount = {
    valueOf() {
      conversions++;
      return 1;
    },
  };
  expect(() => bus.emitSettlement(event(amount))).toThrow();
  expect(conversions).toBe(0);
});

test("supported primitive representations keep precision and frozen copies", () => {
  for (const amount of [
    0,
    1,
    Number.MAX_SAFE_INTEGER,
    0n,
    9007199254740993n,
    "0",
    "9007199254740993",
    "001",
  ]) {
    const bus = new SettlementBus();
    const input = event(amount);
    let received: SettlementEvent | undefined;
    bus.on("settlement", (value: SettlementEvent) => {
      received = value;
    });
    expect(bus.emitSettlement(input)).toBe(true);
    expect(received?.amount).toBe(amount);
    expect(received).not.toBe(input);
    expect(Object.isFrozen(received)).toBe(true);
  }
});

test("existing invalid numeric and string forms remain rejected", () => {
  const bus = new SettlementBus();
  for (const amount of [
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    -1n,
    "",
    "-1",
    "1.2",
  ])
    expect(() => bus.emitSettlement(event(amount))).toThrow();
});

test("EventEmitter return values and synchronous listener errors stay unchanged", () => {
  const bus = new SettlementBus();
  // false 只表示没有监听者，不表示付款失败；监听者异常仍由调用方处理。
  expect(bus.emitSettlement(event(1n))).toBe(false);
  let calls = 0;
  bus.on("settlement", () => {
    calls++;
    throw new Error("fixture listener failure");
  });
  expect(() => bus.emitSettlement(event(1n))).toThrow(
    "fixture listener failure",
  );
  expect(calls).toBe(1);
});

test("required identity fields must remain nonempty strings", () => {
  const bus = new SettlementBus();
  for (const field of ["payer", "txHash"])
    for (const value of [true, 1, {}, [], null, undefined, ""])
      expect(() =>
        bus.emitSettlement({ ...event(1n), [field]: value }),
      ).toThrow();
});

test("the event is snapshotted once so validation and emitted fields cannot diverge", () => {
  const bus = new SettlementBus();
  const input = event(1);
  let reads = 0;
  Object.defineProperty(input, "amount", {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? 1 : false;
    },
  });
  let observed: unknown;
  bus.on("settlement", (value: SettlementEvent) => {
    observed = value.amount;
  });
  expect(bus.emitSettlement(input)).toBe(true);
  expect(observed).toBe(1);
  expect(reads).toBe(1);
});
