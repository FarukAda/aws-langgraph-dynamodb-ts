# The idempotency cache on a transactional `Delete`

Run conditions: run 2 in [`README.md`](./README.md).

## E-13: the idempotency cache covers a transactional `Delete` exactly as it covers a `Put`

**Request** — write a row; send a one-item `TransactWriteItems` carrying a
`Delete` and a `ClientRequestToken`; once it resolves, write a **new** row at the
same key; resend the byte-identical delete request, same token.

**Response**

```
1. first call: OK (row deleted)
2. replay, same token+body: OK
3. row after replay: {"rev":"R2","PK":"p","v":2,"SK":"d1"}
```

The row written **after** the first delete survived the replay: had the replay
been re-evaluated rather than answered from the cache, an unconditional `Delete`
would have removed whatever a competitor had written since.

**What this settles.** A one-item `TransactWriteItems` carrying a `Delete` and a
`ClientRequestToken` is answered from the idempotency cache exactly as one
carrying a `Put` is — this is the fact the whole delete-side design (a token plus
a condition, re-pinned from a rejection) rests on.

**What the probe did not cover.** A transaction mixing a `Delete` with a `Put` in
the same call — only a single-item `Delete` transaction, the shape this package
sends, was probed.
