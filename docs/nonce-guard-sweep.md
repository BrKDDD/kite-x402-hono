# Nonce guard cap handling and sweep cost

## Problem

### 1. A settled nonce could be dropped at the entry cap

`commit()` returned early whenever the map already held `maxEntries` records:

```ts
if (!this.entries.has(key) && this.entries.size >= this.maxEntries) return;
```

`acquire()` reclaimed expired records before its own cap check, but `commit()`
did not. Since `commit()` runs after verification, the upstream call and
settlement, records that were live at acquisition time can lapse before the
commit lands. Those lapsed records then occupy the cap, and a nonce that had just
been settled was silently not recorded, so a later `check()` reported that
settled nonce as `AVAILABLE`.

The payment is still refused later, because `acquire()` hits the same cap, so
this did not reopen the replay window. It did make the guard misreport the state
of a settled nonce, and it made the early replay rejection in
`payment-protection.ts` miss, costing a wasted facilitator round trip per
affected retry.

Verified against the previous source with a behavioural probe that asserts only
public results: the probe reports `AVAILABLE` where `CONSUMED` is required. With
this change the same probe reports `CONSUMED`.

### 2. Every acquisition swept the whole map

`acquire()` called `cleanExpired()` unconditionally, and `cleanExpired()` walks
every tracked entry. `acquire()` is reached from `FacilitatorClient.verify` for
every payment-bearing request, so the cost of one payment grew with the number of
nonces retained in the sliding window.

Measured on Bun 1.4.4, 2,000 consecutive `reserve()` calls with the clock
advancing 1 ms per call, both columns the same implementation with
`sweepIntervalMs` set to `0` and `1000`:

| retained entries | sweep per acquisition (before) | throttled sweep (after) |
| --- | --- | --- |
| 10,000 | 227.4 ms total / 113.7 µs per call | 0.9 ms total / 0.5 µs per call |
| 5,000 | 107.3 ms total / 53.7 µs per call | 0.9 ms total / 0.4 µs per call |

The guard performed 2,000 full scans before the change and 2 after it. This cost
only matters once a deployment retains thousands of live nonces, which is the same
condition that makes the cap reachable; a low-traffic deployment stays in the
microsecond range either way.

## Change and evidence

`commit()` and `acquire()` now reclaim lapsed entries before acting on an entry
count, so a reclaimed slot is never mistaken for a genuine cap:

- `commit()` reclaims first and only gives up when the cap is real, so a settled
  nonce is recorded whenever the map can make room.
- `acquire()` reclaims first and only refuses when the cap is real, so a payment
  whose only obstacle was an unreclaimed slot is admitted.

Sweeping itself now runs at most once per `sweepIntervalMs` (default 1000 ms; `0`
restores the previous per-acquisition sweep). The interval is validated on
construction, and `sweepCount` reports how many scheduled sweeps ran so the bound
is observable rather than assumed.

Throttling a sweep is only safe if no decision depends on how recently the map was
cleaned. Every decision path reads the entry it cares about: `check()` compares
that entry's `expiresAt` against the supplied clock, `acquire()` deletes a lapsed
entry for the requested `(payer, nonce)` before inserting, and `release()` /
`reserve().commit()` operate on identified entries. Expired records may therefore
linger for up to one interval without widening the replay window.

Nine regression tests in `tests/nonce-guard-sweep.test.ts` cover the interval
behaviour, unchanged expiry decisions inside an interval, both cap paths, the `0`
compatibility mode, invalid intervals, and that a scheduled sweep never reclaims
an active lease. The full suite passes: 287 tests, 0 failures. Of those nine, the
cap-path `commit()` case fails against the previous source; the `acquire()` cap
case passes there, because the previous code swept on every call, and it exists to
pin the behaviour that throttling could otherwise regress.

## Limits

A scheduled sweep still walks the whole map when it runs, so the cost becomes
`entries / sweepIntervalMs` rather than `entries` per payment; it is amortised, not
eliminated. Expired entries may remain tracked for up to one interval, which is why
both cap paths reclaim exactly instead of trusting the count.

An in-flight lease keeps `expiresAt` at infinity and is never reclaimed by time, as
documented for `inFlightTtlMs`; a caller that neither commits nor releases it holds
its slot until `clear()`. When the cap is genuinely full, `commit()` still drops the
record without signalling it: making that outcome observable needs a return value or
a counter, which is left out of this change to keep the API unchanged.

This change does not add lease expiry, persistence or multi-process coordination,
and it makes no claim about on-chain state.
