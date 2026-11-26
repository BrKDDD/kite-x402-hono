import { expect, test, spyOn } from "bun:test";
import { checkPaymentChallenge } from "../src/index.js";
import { PAY_TO } from "./helpers.js";
const options = {
  url: "https://gateway.example/v1/echo",
  expectedNetwork: "testnet",
  expectedAmount: "1",
  expectedPayTo: PAY_TO,
};

test("deadline completes even when injected fetch ignores abort", async () => {
  let signal: AbortSignal | undefined;
  const result = await checkPaymentChallenge(
    { ...options, timeoutMs: 10 },
    async (_url, init) => {
      signal = init.signal!;
      return new Promise<Response>(() => {});
    },
  );
  expect(result.code).toBe("timeout");
  expect(signal!.aborted).toBe(true);
});
test("pre-cancelled request never contacts the endpoint or exposes reason", async () => {
  const controller = new AbortController();
  controller.abort("SECRET");
  let calls = 0;
  const report = await checkPaymentChallenge(
    { ...options, signal: controller.signal },
    async () => {
      calls++;
      return new Response();
    },
  );
  expect(report.code).toBe("cancelled");
  expect(calls).toBe(0);
  expect(JSON.stringify(report)).not.toContain("SECRET");
});
test("caller cancellation completes a non-cooperative fetch and removes listener", async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  let requestSignal: AbortSignal | undefined;
  const pending = checkPaymentChallenge(
    { ...options, signal: controller.signal },
    async (_url, init) => {
      requestSignal = init.signal!;
      return new Promise<Response>(() => {});
    },
  );
  controller.abort(new Error("SECRET"));
  const report = await pending;
  expect(report.code).toBe("cancelled");
  expect(requestSignal!.aborted).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report)).not.toContain("SECRET");
  remove.mockRestore();
});
test.each(["timeout", "cancelled"] as const)(
  "discards responses arriving after %s",
  async (reason) => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    const pending = checkPaymentChallenge(
      { ...options, timeoutMs: 10, signal: controller.signal },
      async () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    if (reason === "cancelled") controller.abort();
    const report = await pending;
    expect(report.code).toBe(reason);
    let cancelled = false;
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
    expect(report.code).toBe(reason);
  },
);
test("late rejection is consumed after timeout", async () => {
  let reject!: (reason: Error) => void;
  const pending = checkPaymentChallenge(
    { ...options, timeoutMs: 5 },
    async () =>
      new Promise<Response>((_r, fail) => {
        reject = fail;
      }),
  );
  expect((await pending).code).toBe("timeout");
  reject(new Error("SECRET late failure"));
  await new Promise((r) => setTimeout(r, 0));
});
test("completed requests remove cancellation listener and keep their result", async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  const report = await checkPaymentChallenge(
    { ...options, signal: controller.signal },
    async () => new Response(null, { status: 402 }),
  );
  expect(remove).toHaveBeenCalledTimes(1);
  controller.abort();
  expect(report.code).toBe("missing_header");
  remove.mockRestore();
});
test("synchronous fetch errors stay redacted and remove listener", async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  const report = await checkPaymentChallenge(
    { ...options, signal: controller.signal },
    () => {
      throw new Error("SECRET");
    },
  );
  expect(report.code).toBe("unreachable");
  expect(remove).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report)).not.toContain("SECRET");
  remove.mockRestore();
});
test("native HTTP fetch waiting for headers obeys the deadline", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => new Promise<Response>(() => {}),
  });
  try {
    const report = await checkPaymentChallenge({
      ...options,
      url: `${server.url}v1/stall`,
      timeoutMs: 30,
    });
    expect(report.code).toBe("timeout");
  } finally {
    await server.stop(true);
  }
});
