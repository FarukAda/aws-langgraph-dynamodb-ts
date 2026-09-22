# Conditional `DeleteItem` against an absent or partially-shaped row

Run conditions: run 2 and run 3 in [`README.md`](./README.md).

## E-14: a conditional `DeleteItem` against an already-gone row is refused with no item attached

**Request** — a conditional `DeleteItem` against a key that was never written.

**Response**

```
name: ConditionalCheckFailedException
Item present on the exception? NO
```

**What this settles.** "No item on the rejection" means the row is already gone —
count it deleted and release the object it named — while "an item on the
rejection" means it was rewritten since the read and must be left alone. The two
cases are distinguishable from the rejection alone, without a second read that
would race the same writer again.

**What the probe did not cover.** Whether the same absent-row rejection shape
holds inside a `TransactWriteItems` `Delete` as well as a plain `DeleteItem` — it
does, reported as one cancellation reason with no `Item`, but that variant was
reasoned from this probe and from the local DynamoDB emulator rather than measured
directly against real AWS.

## E-15: a document-path condition evaluates to false, never `ValidationException`, when the guarded attribute or its inner field is absent

**Request** — a document-path condition over a payload descriptor
(`#pin.#field = :pin`) sent as the delete's guard, against four rows: one carrying
the descriptor with the expected id, one carrying the descriptor without an id
inside it, one carrying the descriptor in a different (inline) shape without the
guarded field, and one with **no** descriptor attribute at all.

**Response**

```
descriptor carries the id: deleted
descriptor present, NO id (inner miss): ConditionalCheckFailedException (rejection carried the row)
descriptor is a different shape: deleted
no descriptor attribute at all: ConditionalCheckFailedException (rejection carried the row)
```

**What this settles.** A document-path condition evaluates to **false** — not
`ValidationException` — whenever the outer attribute is missing entirely, or
present but missing the field the condition names. One condition shape therefore
works for a row this package's own writes produced and for a row a concurrent
writer rewrote out from under it, without a type error interrupting the delete.
Every refusal in this probe still attached the row to the rejection, so the
"already gone" / "rewritten since the read" decode of E-14 holds for this
document-path guard too.

**Read carefully what this does *not* say.** It is not "a row with no id is
refused". The condition is only ever sent for a row a partition read **observed
carrying an id**; a row observed *without* one is deleted unconditionally, by
design, because refusing those would leave data written before this guard existed
undeletable at all — an availability regression worse than the narrow erasure this
guard closes. What this probe measures is the other case: a row observed **with**
an id that no longer carries it when the delete lands.

**What the probe did not cover.** A document path nested more than one level deep
— only the single level (`#pin.#field`) this package's guard actually sends was
probed.
