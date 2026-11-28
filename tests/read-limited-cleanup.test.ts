import { expect, test } from "bun:test";
import { readLimited, BodyTooLarge } from "../src/proxy.js";

function fakeStream(
  cancel: () => unknown,
  { finish = false }: { finish?: boolean } = {},
) {
  const chunk = new TextEncoder().encode("0123456789");
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (finish && sent) return { done: true, value: undefined };
        if (sent) throw new Error("unexpected extra read");
        sent = true;
        return { done: false, value: chunk };
      },
      cancel,
      releaseLock: () => {},
    }),
  } as unknown as ReadableStream<Uint8Array>;
}

test("a throwing reader cancel cannot replace BodyTooLarge", async () => {
  await expect(
    readLimited(
      fakeStream(() => {
        throw new Error("cleanup boom");
      }),
      4,
    ),
  ).rejects.toBeInstanceOf(BodyTooLarge);
});

test("a non-promise reader cancel cannot replace BodyTooLarge", async () => {
  await expect(
    readLimited(
      fakeStream(() => undefined),
      4,
    ),
  ).rejects.toBeInstanceOf(BodyTooLarge);
});

test("a rejecting reader cancel stays best-effort", async () => {
  await expect(
    readLimited(
      fakeStream(() => Promise.reject(new Error("cleanup boom"))),
      4,
    ),
  ).rejects.toBeInstanceOf(BodyTooLarge);
});

test("cleanup failure does not alter a successfully bounded read", async () => {
  const bytes = await readLimited(
    fakeStream(
      () => {
        throw new Error("cleanup boom");
      },
      { finish: true },
    ),
    64,
  );
  expect(new TextDecoder().decode(bytes)).toBe("0123456789");
});

test("abort diagnostics survive a hostile cancel", async () => {
  const controller = new AbortController();
  const stream = fakeStream(() => {
    throw new Error("cleanup boom");
  });
  controller.abort();
  try {
    await readLimited(stream, 64, controller.signal);
    throw new Error("expected rejection");
  } catch (error) {
    expect((error as Error).name).toBe("AbortError");
  }
});
