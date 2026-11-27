import { describe, expect, test } from "bun:test";
import { BodyTooLarge, readLimited } from "../src/proxy.js";

function reusedChunks(buffer: Uint8Array, texts: string[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === texts.length) {
          controller.close();
          return;
        }
        buffer.set(new TextEncoder().encode(texts[index++]!));
        controller.enqueue(buffer);
      },
    },
    { highWaterMark: 0 },
  );
}

describe("bounded stream reader owns consumed bytes", () => {
  test.each([false, true])(
    "keeps bytes when the producer reuses a pooled buffer (Buffer=%s)",
    async (nodeBuffer) => {
      const buffer = nodeBuffer ? Buffer.alloc(2) : new Uint8Array(2);
      const result = await readLimited(
        reusedChunks(buffer, ["ab", "cd", "ef"]),
        6,
      );
      expect(new TextDecoder().decode(result)).toBe("abcdef");
      buffer.fill(0);
      expect(new TextDecoder().decode(result)).toBe("abcdef");
    },
  );

  test("retains exact subarray bytes rather than the whole backing allocation", async () => {
    const allocation = new Uint8Array(8);
    const result = await readLimited(
      reusedChunks(allocation.subarray(2, 4), ["ab", "cd"]),
      4,
    );
    expect([...result]).toEqual([97, 98, 99, 100]);
  });

  test("size limits and abort rejection still apply before returning data", async () => {
    await expect(
      readLimited(reusedChunks(new Uint8Array(2), ["ab", "cd"]), 3),
    ).rejects.toBeInstanceOf(BodyTooLarge);
    const controller = new AbortController();
    controller.abort(new Error("fixture-abort"));
    await expect(
      readLimited(
        reusedChunks(new Uint8Array(2), ["ab"]),
        2,
        controller.signal,
      ),
    ).rejects.toThrow("fixture-abort");
  });
});
