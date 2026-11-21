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

- **Expiry is reclaimed in deadline order.** `acquire()` pushes completed records
  into a min-heap keyed by `expiresAt` and pops only entries whose deadline has
  passed. This restores the previous full sweep's effect before any capacity
  decision, without walking live records. An in-flight reservation carries an
  infinite expiry and is released by its owner, as before.
- **Eviction reads an index.** `completedKeys` holds completed keys oldest
  completion first, so the eviction candidate is the first element of a `Set`.
  Because lapsed records were just reclaimed, that candidate is a live response.
- **Byte accounting is incremental.** `cachedBytes` is updated on insert and
  removal instead of being recomputed. `bytes()` exposes it, which makes the
  invariant observable: it must equal the sum of completed body sizes.
- **One removal path.** `drop()` is the single place that deletes a record, so the
  map, the index, the counter and the expiry heap cannot fall out of step. Heap
  positions are indexed by key, so a replaced or evicted record leaves no stale
  entry and the heap stays bounded by live completed records.

The byte budget keeps its exact previous semantics. The old code compared
`sum(completed bodies except this key) + new body` against `maxBytes`; the counter
now subtracts the replaced record's own body before comparing, which is the same
expression. Reclaiming lapsed records before that comparison matters: without it,
expired bodies from other keys still consume the budget and a fresh response is
discarded. A differential probe against the previous source reproduced that
regression (upstream `cached`, first draft `acquired`) and now matches. The same
probe covers capacity pressure, where the first draft could evict a live response
while leaving a lapsed one in place. A completion that fills the budget exactly is
still kept, and one that exceeds it still discards the record rather than truncating it.

After the change, re-measured over 50,000 operations with the cache already at
capacity (finer resolution than the 2,000-operation baseline above):

| keys  | `acquire()` (after) | `acquire()` + `complete()` (after) |
| ----- | ------------------- | ---------------------------------- |
| 1,000 | 0.57 µs per call    | 2.82 µs per pair                   |
| 5,000 | 0.45 µs per call    | 6.24 µs per pair                   |

The 5,000-key pair drops from 410.7 µs to 6.24 µs. Twelve new tests in
`tests/idempotency-accounting.test.ts` pin the accounting: budget boundaries in
both directions, replacement without double counting, lapsed peers releasing bytes,
eviction releasing bytes, `clear()` resetting the index, a capacity full of live
reservations still returning `conflict`, and the two upstream-differential
regressions. The existing 278 tests pass unchanged, which is what pins the
decision behaviour.

## Behaviour that changed

One choice changed deliberately and is limited.

- The eviction candidate is the oldest **completion**, where the previous code took
  the oldest **reservation** that had completed. Re-completing a key moves it to the
  end of the index. Both are live completed records after the expiry heap runs;
  this one evicts the response that has been reusable the longest.

`size()` and the `acquire` / `conflict` / `in_flight` / `cached` decisions were
compared against the previous source for the same sequences and are identical
again, including the two capacity and byte-budget cases above.

## Limits

Expired records are reclaimed at the next `acquire()` or by an explicit
`cleanExpired()` call; `complete()` alone does not sweep peers, matching the
previous source. Heap maintenance adds O(log n) work per completion or reclaimed
record, which is why the pair cost is no longer flat microsecond-scale, but it
remains independent of the number of live records scanned. `cleanExpired()` is
still a full scan and is a maintenance call, not part of the request path.

An in-flight reservation still never expires by time: a caller that neither
completes nor releases it holds its slot until `clear()`. This change does not add
persistence or cross-process coordination, and the cached bodies are still
process-local.
