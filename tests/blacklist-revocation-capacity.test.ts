import { expect, test } from "bun:test";
import { TokenBlacklist } from "../src/middleware/token-blacklist.js";

const HOUR = 60 * 60 * 1000;

function runAt<T>(now: number, fn: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

test("far-future expiry cannot occupy the list and disable revocation", () => {
  runAt(1_000_000, () => {
    const bl = new TokenBlacklist(3);
    const far = Number.MAX_SAFE_INTEGER;
    expect(() => bl.revoke("attacker-a", far)).toThrow("Invalid revocation");
    expect(() => bl.revoke("attacker-b", far)).toThrow("Invalid revocation");
    expect(() => bl.revoke("attacker-c", far)).toThrow("Invalid revocation");

    // The attack entries were rejected, so a real revocation still fits.
    bl.revoke("victim-compromised-jti", Date.now() + HOUR);
    expect(bl.isRevoked("victim-compromised-jti")).toBe(true);
    expect(bl.isRevoked("attacker-a")).toBe(false);
  });
});

test("a bounded but distant expiry is still accepted", () => {
  runAt(1_000_000, () => {
    const bl = new TokenBlacklist(2);
    const tenYears = 10 * 365 * 24 * HOUR;
    bl.revoke("long-lived", 1_000_000 + tenYears);
    expect(bl.isRevoked("long-lived")).toBe(true);
    expect(() => bl.revoke("too-far", 1_000_000 + tenYears + 1)).toThrow(
      "Invalid revocation",
    );
  });
});

test("existing fail-closed capacity contract is unchanged", () => {
  runAt(100_000, () => {
    const bl = new TokenBlacklist(1);
    bl.revoke("a", 105_000);
    expect(() => bl.revoke("b", 120_000)).toThrow("capacity");
    expect(bl.isRevoked("a")).toBe(true);
    // expired slot is reclaimed and reusable
    Date.now = () => 110_000;
    expect(bl.isRevoked("a")).toBe(false);
    bl.revoke("b", 120_000);
    expect(bl.isRevoked("b")).toBe(true);
  });
});

test("re-revoking with a longer deadline extends, never shortens", () => {
  runAt(1_000_000, () => {
    const bl = new TokenBlacklist(2);
    bl.revoke("a", 1_000_000 + HOUR);
    bl.revoke("a", 1_000_000 + 3 * HOUR);
    Date.now = () => 1_000_000 + 2 * HOUR;
    expect(bl.isRevoked("a")).toBe(true);
    Date.now = () => 1_000_000 + 4 * HOUR;
    expect(bl.isRevoked("a")).toBe(false);
  });
});

test("heap reclamation matches a full-scan reference over mixed operations", () => {
  runAt(0, () => {
    const bl = new TokenBlacklist(1000);
    const reference = new Map<string, number>();
    let seed = 7;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let now = 1_000; now <= 20_000; now += 250) {
      Date.now = () => now;
      for (let k = 0; k < 12; k++) {
        const jti = `j${Math.floor(random() * 60)}`;
        const ttl = Math.floor(random() * 8) * 250;
        const expires = now + ttl;
        // ttl === 0 is a silent no-op in revoke(), not a rejection.
        const valid = expires <= now + 10 * 365 * 24 * HOUR;
        let accepted = true;
        try {
          bl.revoke(jti, expires);
        } catch {
          accepted = false;
        }
        if (valid) {
          if (!reference.has(jti) || reference.get(jti)! < expires)
            reference.set(jti, expires);
        } else {
          expect(accepted).toBe(false);
        }
      }
      for (let k = 0; k < 60; k++) {
        const jti = `j${k}`;
        const expected = (reference.get(jti) ?? 0) > now;
        expect(bl.isRevoked(jti)).toBe(expected);
        if (!expected) reference.delete(jti);
      }
    }
  });
});

test("revoke stays flat as the list grows", () => {
  runAt(1_000_000, () => {
    const measure = (count: number): number => {
      const bl = new TokenBlacklist(count + 2001);
      for (let i = 0; i < count; i++)
        bl.revoke(`seed-${i}`, 1_000_000 + 10 * HOUR);
      const start = performance.now();
      for (let i = 0; i < 2000; i++)
        bl.revoke(`new-${i}`, 1_000_000 + 10 * HOUR);
      return ((performance.now() - start) * 1000) / 2000;
    };
    const small = measure(100);
    const large = measure(2000);
    // Both fill to capacity; revoke must not degrade linearly with live entries.
    expect(large).toBeLessThan(Math.max(small * 5, 20));
  });
});

test("re-revocation keeps the expiry heap ordered so stale slots are reclaimed", () => {
  runAt(1_000_000, () => {
    const bl = new TokenBlacklist(6);
    const apply = (jti: string, expiresAt: number, at: number): void => {
      Date.now = () => at;
      bl.revoke(jti, expiresAt);
    };

    apply("j24", 1006381, 1001322);
    apply("j28", 1009100, 1002140);
    apply("j36", 1005229, 1002140);
    apply("j6", 1010689, 1005039);
    apply("j35", 1011701, 1005039);
    apply("j4", 1007934, 1005039);
    // Genuine capacity rejection at this timestamp (all six entries are live).
    expect(() => apply("j7", 1010890, 1005039)).toThrow("capacity");

    // Re-revocations move entries inside the heap. A one-directional sift
    // leaves a stale entry below the root, where reclamation cannot see it.
    apply("j35", 1007689, 1005039);
    apply("j23", 1012576, 1006379);
    apply("j30", 1009219, 1008488);
    apply("j30", 1011815, 1008488);

    // j24, j36 and j4 are all expired by now; their slots must be reusable.
    expect(() => apply("j12", 1011183, 1008488)).not.toThrow();
    expect(bl.isRevoked("j12")).toBe(true);
  });
});

test("JWT seconds still convert to milliseconds and are bounded", () => {
  runAt(1_000_000, () => {
    const bl = new TokenBlacklist(2);
    bl.revokeJwt("jwt", 2000);
    expect(bl.isRevoked("jwt")).toBe(true);
    Date.now = () => 2_000_001;
    expect(bl.isRevoked("jwt")).toBe(false);
    // A safe-integer JWT exp that still converts to a deadline beyond TTL.
    expect(() =>
      bl.revokeJwt("far", Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
    ).toThrow("Invalid revocation");
  });
});
