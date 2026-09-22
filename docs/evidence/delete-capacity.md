# What a conditional delete costs, and what a refusal reports

Run conditions: run 2 and run 3 in [`README.md`](./README.md).

## E-16: a successful conditional delete is charged capacity sized to the row; a refused one reports none

**Request** — write a ~300 KB row; issue a conditional `DeleteItem` against it with
a condition that is false (`ReturnConsumedCapacity: 'TOTAL'`); then issue the same
delete with a condition that is true.

**Response**

```
refusal: ConditionalCheckFailedException; ConsumedCapacity on the error: ABSENT
success: ConsumedCapacity { CapacityUnits: 301 }
```

**What this settles.** A **successful** conditional delete is charged on the size
of the row it removes, not a flat per-request unit — roughly 301 capacity units for
a ~300 KB row — which matters for a checkpoint row carrying an inline payload, and
doubles inside a transaction. A **refused** conditional delete returns **no**
`ConsumedCapacity` at all, so its charge cannot be observed from the response; any
text pricing a refusal has to cite the documentation (which puts it at the size of
the existing item) rather than a measurement, because this probe could not produce
one.

**What the probe did not cover.** The capacity charge for a delete on a small
(sub-1 KB) row, or for a delete inside a `TransactWriteItems` call rather than a
plain `DeleteItem` — only the plain-`DeleteItem` number was measured directly.
