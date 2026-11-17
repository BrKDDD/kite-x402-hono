# Idempotency cache request path

## Problem

`IdempotencyCache` sits on the paid request path: `payment-protection.ts` calls
`acquire()` before forwarding a paid retry and `complete()` after a settled
success. Three operations in that path scanned the whole cache.

1. `acquire()` began with `cleanExpired(now)`, which walks every record.
2. `acquire()` at capacity ran `[...this.records].find(...)`, materialising every
   key/value pair just to locate one evictable record.
3. `complete()` ran `[...this.records.entries()].reduce(...)`, materialising every
   pair to sum the cached body bytes.

The cost therefore grew with the number of keys held, and each of the three
allocated an array of the full cache on every request. Measured on Bun 1.4.4 over
2,000 operations with the cache already at capacity:

| keys  | `acquire()` (before) | `acquire()` + `complete()` (before) |
| ----- | -------------------- | ----------------------------------- |
| 1,000 | 13.4 µs per call     | 69.3 µs per pair                    |
| 5,000 | 75.5 µs per call     | 410.7 µs per pair                   |

At 5,000 keys and 1,000 paid retries per second that is over 400 ms of CPU per
second spent scanning a cache, plus the garbage from 2,000 arrays per second.

## Change and evidence

Each scan is replaced by a structure that answers the same question directly:

- **Expiry is decided per key.** `acquire()` compares the requested key's own
  `expiresAt` with the supplied clock instead of sweeping the cache. An in-flight
  reservation carries an infinite expiry, so it is never dropped here — it is
  released by its owner, as before.
- **Eviction reads an index.** `completedKeys` holds completed keys oldest
  completion first, so the eviction candidate is the first element of a `Set`.
  Only completed records can be evicted, and a lapsed record is completed too, so
  the oldest completion is also the first thing worth reclaiming.
- **Byte accounting is incremental.** `cachedBytes` is updated on insert and
  removal instead of being recomputed. `bytes()` exposes it, which makes the
  invariant observable: it must equal the sum of completed body sizes.
- **One removal path.** `drop()` is the single place that deletes a record, so the
  map, the index and the counter cannot fall out of step.

The byte budget keeps its exact previous semantics. The old code compared
`sum(completed bodies except this key) + new body` against `maxBytes`; the counter
now subtracts the replaced record's own body before comparing, which is the same
expression. A completion that fills the budget exactly is still kept, and one that
exceeds it still discards the record rather than truncating it.

After the change, the same measurement:

| keys  | `acquire()` (after) | `acquire()` + `complete()` (after) |
| ----- | ------------------- | ---------------------------------- |
| 1,000 | 0.7 µs per call     | 1.5 µs per pair                    |
| 5,000 | 0.3 µs per call     | 1.3 µs per pair                    |

The 5,000-key pair drops from 410.7 µs to 1.3 µs. Ten new tests in
`tests/idempotency-accounting.test.ts` pin the accounting: budget boundaries in
both directions, replacement without double counting, expiry and eviction
releasing bytes, `clear()` resetting the index, and a capacity full of live
reservations still returning `conflict` instead of discarding a lease. The existing
278 tests pass unchanged, which is what pins the decision behaviour.

## Behaviour that changed

Both changes are deliberate and limited.

- `size()` no longer drops unrelated expired records as a side effect of acquiring.
  On the previous source, acquiring one expired key also swept every other expired
  record, so `size()` fell accordingly. Now only the requested key is reclaimed.
  Decisions are unaffected: `acquire`, `conflict`, `in_flight` and `cached` were
  compared against the previous source for the same sequence and are identical.
- The eviction candidate is the oldest **completion**, where the previous code took
  the oldest **reservation** that had completed. Re-completing a key moves it to the
  end of the index. Either choice is a completed record under pressure; this one
  evicts the response that has been reusable the longest.

## Limits

Expired records stay in the map until their own key is acquired, capacity pressure
evicts them, or `cleanExpired()` is called explicitly. Memory remains bounded by
`maxKeys`, and the accounting remains correct, but `size()` can be larger than the
number of unexpired records. `cleanExpired()` is still a full scan and is a
maintenance call, not part of the request path.

An in-flight reservation still never expires by time: a caller that neither
completes nor releases it holds its slot until `clear()`. This change does not add
persistence or cross-process coordination, and the cached bodies are still
process-local.
