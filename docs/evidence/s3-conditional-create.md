# Conditional `PutObject` on S3

Run conditions: run 1 in [`README.md`](./README.md). Every probe issued against the
raw SDK, `maxAttempts: 1`, against a bucket created for the run and deleted after.

## E-7: `PutObject` with `If-None-Match: *` against an existing key is refused

**Request** — `PutObject` an object; `PutObject` the same key again with
`IfNoneMatch: '*'`.

**Response**

```
name=PreconditionFailed Code=PreconditionFailed status=412
msg=At least one of the pre-conditions you specified did not hold
```

**What this settles.** Both fields this package's offload path checks for a
conditional-create refusal — `name === 'PreconditionFailed'` and
`$metadata.httpStatusCode === 412` — are present on the same rejection, so either
alone would suffice.

**What the probe did not cover.** A `PutObject` racing a `DeleteObject` on the same
key rather than an already-settled existing object.

## E-8: a conditional `PutObject` that loses a race is refused with `ConditionalRequestConflict`/409

**Request** — two concurrent `PutObject` calls at the same key, both carrying
`IfNoneMatch: '*'`, repeated over many rounds so the race is actually taken rather
than settled by ordering.

**Response**

```
409 observed as ConditionalRequestConflict/409
raw: name=ConditionalRequestConflict Code=ConditionalRequestConflict status=409
msg=The conditional request cannot succeed due to a conflicting operation against this resource.
```

**What this settles.** The loser of a conditional-create race is refused with
exactly the literal token this package's S3 retry classifier already names —
`ConditionalRequestConflict` — rather than a generic `409` with some other name.
This was previously unverifiable offline: the API reference documents the status
code but not the exception name a client actually receives.

**What the probe did not cover.** Whether the body is uploaded before or after the
precondition is evaluated (a bandwidth question, not a correctness one) — costs
this package nothing either way, since its own conditional upload only re-sends a
body when a previous attempt's did not land.
