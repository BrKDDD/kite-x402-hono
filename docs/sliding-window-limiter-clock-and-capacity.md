# SlidingWindowLimiter: clock rollback and reclaim cost

## Scope

`src/middleware/sliding-window-limiter.ts` is exported from `src/index.ts` and used
by `adaptiveRateLimiter()` (`src/middleware/adaptiveRateLimiter.ts`). The repo's
own default proxy uses `rate-limiter.ts` instead, so the defects below affect
downstream applications that explicitly integrate this middleware — not the
default proxy route. The upstream PRs #125 / #128 touch `rate-limiter.ts` and do
not fix any of this.

## Defects reproduced on origin/main (`1d75028`)

1. **Clock rollback clears an active window.** `revoke()`-style sweep used
   `(times.at(-1) ?? 0) <= cutoff` on the assumption that the last element is
   the newest timestamp. A clock step backwards pushes a smaller timestamp to
   the tail, so `at(-1)` is no longer the maximum. When the clock advances
   again, that smaller value crosses the cutoff first and the whole key is
   deleted. Reproduced: a victim with timestamps `[1000000, 900000]` was
   removed at `now=970000`, then got a fresh full quota. NTP steps, VM
   migration and container clock resets all trigger this. `resetSeconds` also
   becomes wrong because the array is no longer ordered.
2. **Denied requests pay O(n).** The full-map sweep runs before both the
   capacity check and the per-key quota check, so every rejected request
   iterates all keys. Measured 22.96 µs at 100 keys vs 169.65 µs at 10000 keys
   (~7.4×, still growing). An attacker who creates many keys amplifies each
   rejected request into 10000 iterations of synchronous work.
3. **Fixed 10000-key ceiling.** `maxKeys` was hardcoded. Deployments with
   large legitimate identity sets cannot raise it; small ones cannot lower it.
   This is a configurability gap, not a fail-open bug.

## Decisions

- **Keep timestamps sorted and monotonic per key.** Insert each new timestamp
  at its binary-search position so the array is always ascending. When the
  clock has stepped backwards, clamp the new timestamp to the newest already
  recorded for that key: recording a smaller value would create a fake
  "oldest live request" that inflates `resetSeconds` and holds a slot past its
  real expiry. The clamp is per key, not a global clock freeze, so unrelated
  keys still observe real time. `cutoff` still uses the real `Date.now()`.
- **Min-heap + key→position index for reclamation.** Each key's heap priority
  is its newest timestamp. The sweep pops while `priority <= cutoff`, which is
  O(k log n) for k expired keys instead of O(n) on every call. Capacity is
  checked only after this cheap reclamation.
- **Keep fail-closed capacity.** A full map still rejects a brand-new key; it
  does not evict an incumbent. LRU eviction was considered and rejected: an
  attacker could use a flood of fresh keys to evict legitimate identities'
  state and reset their quotas — the same class of bypass as defect 1.
- **`maxKeys` becomes an optional third constructor argument**, default 10000.
  The existing `(windowSizeMs, maxRequests)` signature and defaults are
  unchanged; all three arguments are validated as safe positive integers.

## Limits

- In-process state only; restart and multi-replica deployment still lose or
  duplicate state. Unchanged.
- The limiter trusts `keyGenerator` for identity (see `adaptiveRateLimiter`).
  It does not normalise key case or encoding: forcing `.toLowerCase()` would
  merge case-sensitive session ids and JWT subjects. Key normalisation stays
  the caller's responsibility.
- A clock jump far into the future still expires all windows; that is normal
  sliding-window behaviour after real time passes, not a defect.
- Rejection still returns `resetSeconds = windowSizeMs/1000` at capacity, which
  is an upper bound rather than a per-key estimate (no key state exists yet).
