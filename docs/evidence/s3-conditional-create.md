# Conditional `PutObject` on S3

Run conditions: runs 1 and 4 in [`README.md`](./README.md). Every probe issued against the
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

## E-8: racing conditional creates of one key: exactly one wins, and no loser overwrites it

**Request** — concurrent `PutObject` calls at one brand-new key, each carrying
`IfNoneMatch: '*'` and a different body, repeated over many rounds on fresh keys so
the race is actually taken; then `GetObject` the key.

**Response**

Run 1, two writers per round:

```
409 observed as ConditionalRequestConflict/409
raw: name=ConditionalRequestConflict Code=ConditionalRequestConflict status=409
msg=The conditional request cannot succeed due to a conflicting operation against this resource.
```

Run 4, five writers per round, ten rounds:

```
every round: 1 fulfilled, 4 refused
refusals: {"PreconditionFailed":40}
GetObject returns the one fulfilled writer's body in every round
```

**What this settles.** Exactly one conditional create of a key wins, and every
loser is refused rather than overwriting it. The S3 User Guide
([*Conditional write behavior*](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html))
says the first write to finish succeeds and S3 fails the rest with
`412 Precondition Failed`, and documents `409 Conflict` for a conditional write
racing a *delete*. Run 4 saw only `412`, run 1 saw a `409`; this package is
correct under either. A `412` is the offload path's "already stored" case (E-7),
and `ConditionalRequestConflict` is the exact name its classifier retries as
`CONTENTION`. So the claim this package relies on is the single winner, not which
refusal a loser gets, and the live test asserts only that.

**What the probe did not cover.** A conditional `PutObject` racing a
`DeleteObject`, the case the User Guide documents for `409`. Also whether the body
is uploaded before or after the precondition is evaluated. That is a bandwidth
question, not a correctness one, and costs this package nothing either way: its own
conditional upload re-sends a body only when a previous attempt's did not land.
