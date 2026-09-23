# `BatchWriteItem` and a condition on a `DeleteRequest`

Run conditions: run 2 in [`README.md`](./README.md).

## E-17: `BatchWriteItem` accepts a condition on a `DeleteRequest` and silently ignores it

**Request** — a `BatchWriteItem` call whose single `DeleteRequest` carries a
`ConditionExpression` that is false against the row.

**Response**

```
accepted; row after: null
```

The request was accepted, reported nothing unprocessed, and the row was deleted
although the condition was false.

**What this settles.** A `ConditionExpression` on a `DeleteRequest` inside a
`BatchWriteItem` call is silently ignored by the service — it says the same thing
whichever layer drops it: the SDK's `DeleteRequest` type carries no such field at
all, so the condition may never even reach the wire. Either way, the batch path
cannot be made safe with a condition at any price; closing a partition-delete race
safely needs individual conditional `DeleteItem` calls, which cost round trips
rather than capacity, since a batch is charged per item exactly as individual
writes are.

**What the probe did not cover.** Whether a condition attached to a `PutRequest`
inside the same batch call is likewise ignored — only the `DeleteRequest` shape
this package's delete path would have needed was probed.
