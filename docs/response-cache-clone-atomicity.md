# Response cache: clone failure must not commit the staged write

## Problem

`ResponseCacheStore.set()` built a staged `Map`, assigned it to `this.cache`, and
only then produced the return value with `structuredClone(entry)`. An untyped
JavaScript caller can put a non-cloneable value under an allowlisted header key
(for example `{"content-type": () => "x"}`). The clone then throws
`DataCloneError` **after** the new state is live:

- failed replacement installs a poisoned entry whose later `get()` also throws;
- failed insertion into a full cache evicts the previous paid response before
  throwing.

Both are confirmed by constructing those inputs against the previous source:
the replacement case left `get("paid")` throwing, and the insertion case left
`get("paid")` returning `null`.

This is not a TypeScript-level concern: `Record<string,string>` forbids the
value, but the cache is a library entry point reachable from untyped callers.
The cost is a paid response the client already paid for becoming unavailable.

## Change and evidence

`set()` now clones twice before `next.set()` and before publishing
`this.cache = next`: one copy is stored, the other is returned. Both clones can
throw `DataCloneError` on input from an untyped caller, so both run before the
state transition. A failure leaves the live cache, its FIFO order and the
previous response untouched; the same `DataCloneError` still reaches the
caller. Storing a clone instead of the caller's `entry` also severs references
to caller-owned values, so mutating them after a successful write can no longer
poison a later `get()`.

`tests/response-cache-clone-atomicity.test.ts` adds five cases: failed
replacement, failed insertion at capacity, FIFO order preserved after a failed
write, a valid write with copies isolated from the caller, and a successful
write followed by caller-side mutation of a passed-in object. Against the
original source the first three fail (`get("paid")` throws, returns `null`, or
returns the poisoned entry) and the fifth throws `DataCloneError`; all five pass
after the change. Every failure assertion pins `DOMException` with
`name === "DataCloneError"`, so changing the error type cannot silently pass.

TTL, 1 MiB and 32 MiB validation, the header allowlist, privacy headers, ETag
generation and the successful return copy are unchanged. The extra clone adds
roughly 6 µs to `set()` on a 4 KiB body (6.8 µs → 13.1 µs over 20k iterations).
Full suite and build must pass before submission.

## Limits

`get()` still clones the stored entry on every read. The store now owns its
entries outright, so caller-side mutation can no longer turn a stored entry
into one that throws; an entry poisoned by an older build in the same process
can still throw until the cache is cleared or the process restarts. The cache
remains in-process and single-writer — no cross-process coordination is added.
