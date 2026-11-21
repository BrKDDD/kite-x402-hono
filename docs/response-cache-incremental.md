# Response cache: incremental retention accounting

## Problem

`ResponseCacheStore.set()` rebuilt the entire cache on every write:

```ts
const next = new Map(
  [...this.cache].filter(([id, entry]) => id !== key && entry.expiresAt > now),
);
if (next.size >= this.maxEntries) {
  const oldest = next.keys().next().value;
  if (oldest !== undefined) next.delete(oldest);
}
const bytes = [...next.values()].reduce(
  (n, entry) => n + Buffer.byteLength(entry.body),
  0,
);
```

Both the clone and the byte sum scale with the number of live entries, even when
the write replaces a single key. The cache sits on the paid-response path, so a
deployment that retains thousands of entries pays for every retained entry on
every response it caches.

Measured on Bun 1.4.4 (Windows), 2,000 `set("hot", ...)` calls after seeding
either 100 or 5,000 entries, `maxEntries = 6,000`:

| live entries | before, per call | after, per call | scale factor             |
| ------------ | ---------------- | --------------- | ------------------------ |
| 100          | 21.13 µs         | 10.82 µs        | baseline                 |
| 5,000        | 1,190.31 µs      | 10.35 µs        | before 56.3× / after ~1× |

The last column is the point: the old cost grew 56× with a 50× larger cache; the
new cost stays flat, which is heap depth and Map hashing rather than entry count.
Repeated runs put the large/small ratio between 0.96× and 1.20×. The "before"
large figure is the failing performance assertion against the previous source
(2,380,615,200 ns for 2,000 writes, against a 211,292,500 ns budget derived from
the 100-entry run); the "after" figures are from the same measurement loop on the
changed source.

## Change and evidence

`src/response-caching.ts` keeps three additional invariants alongside the
existing `Map`:

- `cachedBytes` is incremented and decremented when an entry is inserted or
  dropped, replacing the full byte sum.
- `expiries` is a min-heap of `{ key, expiresAt }`, exposing the earliest
  deadline without scanning entries.
- `expiryIndex` maps key to heap position, keeping arbitrary removal at
  `O(log n)`.

Accepted writes pass through one `drop()` that updates the Map, the byte counter
and the heap together. `clear()` resets all four structures. Rejected writes are
different: the heap nodes of lapsed entries are detached early so the byte budget
can be computed without a full scan, but the Map and `cachedBytes` stay untouched
until every check passes. If the byte check fails, the heap is rebuilt from the
Map so no half-detached index survives a rejected write.

An independent review found two ordering mistakes in the first draft of this
change, both now fixed and pinned by tests:

- Checking the 32 MiB budget before capacity eviction rejected a same-size write
  into a full cache. The staged Map evicted first and then summed bytes, so a
  cache at 32 entries / 32 MiB still accepted another 1 MiB entry. The byte
  calculation now includes the eviction candidate.
- Detaching lapsed heap nodes before a rejected write discarded entries whose
  `expiresAt === now`. `set()` treats that boundary as expired, but `get()` uses
  `Date.now() > expiresAt` and still returns them. The rejected write now
  rebuilds the index and leaves those entries visible.

The observable contract is unchanged:

- `set()` still treats `expiresAt === now` as expired, while `get()` still treats
  it as live; `Date.now() > expiresAt` remains the only expiry test in `get()`.
- Capacity eviction still uses Map insertion order, skips the replaced key and
  removes only one entry. Replacing a key deletes and re-inserts it, moving it to
  the eviction tail.
- A write rejected by the 32 MiB budget leaves the Map, the byte counter and the
  heap describing the same live cache as before the call.
- Replacing a key removes its old heap node, so the heap root never points at a
  deadline that is no longer current.

`tests/response-cache-incremental.test.ts` adds twelve cases: the scale
assertion, stale-heap-root replacement, expired peers at capacity, replacement to
the eviction tail, failed-write atomicity, same-size write into a full cache,
rejected write preserving an exact-deadline entry, byte release on `get()`
expiry, budget reset on `clear()`, a 300-step seeded differential test against a
reference implementation of the original staged-write model, and two index
invariant checks (200 mixed operations plus repeated rejections with the target
itself on the exact-deadline boundary). The differential test fails if any of the
boundary rules above drift; the invariant checks catch a corrupted heap position
or byte count before it surfaces as a wrong eviction.

Full suite: 388 tests, 0 failures; `tsc` build passes. An independent review ran
roughly 100,000 additional differential operations with 1 MiB payloads and found
no behaviour difference from the previous source.

## Limits

Finding the capacity eviction candidate still walks Map keys until it finds one
that is not the replaced key. In the common path that is the first key (`O(1)`);
it approaches `O(n)` only when the replaced key is the earliest inserted entry.
That is a deliberate trade to preserve the original eviction order without a
second ordering structure. A rejected write also rebuilds the heap from the Map,
which is `O(n)`; this only happens on the 32 MiB rejection path, not on accepted
writes.

The heap orders only by `expiresAt`; entries with equal deadlines have no defined
relative order. This cannot change behaviour, because eviction uses Map order and
equal-deadline entries are either all expired or all live at a given instant.

This remains an in-process, in-memory cache with no persistence or cross-process
coordination. The retention bound is unchanged: at most `maxEntries` live entries
and 32 MiB of bodies.
