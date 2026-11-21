# Receipt store retention cost

## Problem

`ReceiptStore` enforced retention by scanning every stored receipt on each read:

```ts
private cleanup(): void {
  for (const [key, receipt] of this.receipts)
    if (Date.now() - receipt.timestampMs >= this.retentionMs)
      this.remove(key);
}
```

`cleanup()` ran from `saveReceipt`, `getByTxHash`, `getByPayer` and `size`. With
a full archive the cost of one audit lookup therefore grew with the number of
retained receipts. Measured on Bun 1.4.4 with 5,000 retained entries and 2,000
lookups:

| operation     | before          | `Map.get` reference |
| ------------- | --------------- | ------------------- |
| `getByTxHash` | 236.5 µs / call | 0.5 µs / call       |

That is ~470× the cost of the underlying map lookup, paid on every receipt read
in the settlement audit path.

## Change and evidence

Expiry is now tracked in a min-heap ordered by `timestampMs`, with a key→position
index so removals stay in sync:

- `cleanup()` inspects only the earliest deadline and stops at the first live
  receipt. It no longer walks the archive.
- `saveReceipt()` and `remove()` update the heap and index together, so an
  overwritten `txHash` or a capacity eviction cannot leave a stale deadline that
  would later drop the wrong entry.
- `clear()` resets the archive, payer index, heap and index together.

Measured on the same machine and workload after the change:

| operation     | before          | after         | `Map.get` reference |
| ------------- | --------------- | ------------- | ------------------- |
| `getByTxHash` | 236.5 µs / call | 0.4 µs / call | 0.2 µs / call       |

Roughly 590× faster than before, and within ~2× of a bare `Map.get`.

Five regression tests in `tests/receipt-store-cleanup.test.ts` cover the cost
not scaling with retention, retention firing on every read path, overwrite not
duplicating an expiry entry, out-of-order timestamps still expiring the earliest
receipt first, and overwriting the earliest-deadline entry leaving no stale heap
root. The two existing `receipt-store` tests pass unchanged.

## Limits

The heap adds O(log n) work per save and per reclaimed receipt, so it is cheaper
than the old full scan but not free. Retention still uses `Date.now()` and the
caller-supplied `timestampMs`; a caller that backdates receipts will have them
reclaimed promptly by design. This change does not add persistence, durable
replay protection, or cross-process coordination — the archive remains
process-local and bounded by `maxEntries`.
