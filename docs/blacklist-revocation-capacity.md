# Token revocation: bound expiry and reclaim without a full scan

## Problem

`TokenBlacklist.revoke()` accepted any non-negative safe integer as
`expiresAt`. `Number.MAX_SAFE_INTEGER` — roughly 285 million years — is a valid
safe integer and never expires. An attacker who can call `revoke()` with
attacker-chosen `jti` values can fill `maxEntries` (default 10000) with such
permanent entries. Every later legitimate revocation then throws
`"Blacklist capacity reached"`:

```text
bl = new TokenBlacklist(3)
bl.revoke("attacker-a", Number.MAX_SAFE_INTEGER)  // ...b, ...c
bl.revoke("victim-compromised-jti", now + 3600000) -> throws
bl.isRevoked("victim-compromised-jti")            -> false
```

The security control fails **open**: a token known to be compromised can no
longer be revoked, so it stays usable until its natural JWT expiry. Unlike a
rate-limit window, permanent entries never age out — only a process restart
recovers.

A second issue is on the same code path. `revoke()` scans every entry on each
call to drop expired ones. Measured: 0.19 µs with an empty list vs 94 µs at
9999 live entries (~495×). An attacker able to trigger revocations can make
each one arbitrarily expensive.

## Change and evidence

1. **Bounded expiry.** `expiresAt` must satisfy
   `expiresAt <= now + MAX_REVOCATION_TTL_MS` (10 years). Ten years is far
   beyond any real JWT lifetime, so legitimate revocations are unaffected;
   it closes the `MAX_SAFE_INTEGER` path. `revokeJwt` inherits the bound after
   converting seconds to milliseconds. An out-of-range value throws
   `"Invalid revocation"` — the same error class as other invalid inputs.
2. **Expiry-ordered reclamation.** An expiry min-heap with a key→position
   index replaces the full scan. `revoke()` pops only entries whose deadline
   has passed before checking capacity, keeping the existing fail-closed
   "capacity reached" error when no slot can be reclaimed. `isRevoked()` keeps
   its O(1) lookup and lazily removes a single expired key.
3. **Two-direction heap repair.** Re-revoking a key replaces its heap node
   with the array's last entry. A downward-only repair can leave a
   parent > child inversion: an expired entry then hides below a live root,
   `reclaimExpired()` never sees it, and a legitimate revocation is wrongly
   rejected with `"Blacklist capacity reached"` — the same fail-open effect as
   the original flaw, reachable through ordinary re-revocation. `removeExpiry()`
   now sifts up first, then sifts down from the position where the entry
   actually settled.

Verified against the previous source: the three-permanent-entry probe above
threw on the legitimate revocation and left `isRevoked("victim...")` false.
After the change the out-of-range entries are rejected at insertion, so the
legitimate revocation succeeds. Heap reclamation is checked against a full-scan
reference over a deterministic interleaving of insert/expire/revoke steps.
An independent review then found the downward-only repair flaw described above:
a 12-step, six-slot sequence of re-revocations left an expired entry below the
root and rejected the final legitimate revocation. That sequence is now a
regression test; with the two-direction repair it passes and no stale expired
entry remains in the heap.

## Limits

In-process revocations only; a restart or a multi-replica deployment still
loses or duplicates state — unchanged from before. The 10-year bound is a
guard rail, not a correctness claim about very long-lived credentials: a
credential that legitimately needs >10 years of revocation is outside this
class's supported range. Callers must still fail closed on
`"Blacklist capacity reached"`; this change prevents attacker-induced capacity
exhaustion but does not turn the error into a soft eviction.
