# Settlement network scope

A SettlementReconciler instance holds receipts for one network. Pass the network as the second constructor argument to bind it before the first record, or omit it to bind to the first accepted receipt. This preserves existing single-network callers while rejecting mixed-network data before deduplication or eviction.

Use a separate instance for each network (and asset/atomic unit). The summary adds raw atomic amounts; it does not convert currencies. clear() removes receipts but retains the network binding. Construct a new instance to change networks. Hash-only lookup is unambiguous within a bound instance.
