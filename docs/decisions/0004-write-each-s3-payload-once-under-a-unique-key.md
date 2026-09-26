# 4. Write each S3 payload once under a unique key

## Status

Accepted.

## Context

An offloaded payload is written to S3 before the DynamoDB row that will
point at it, because the row needs the object's key to store as its
descriptor. A write can be retried — by this package's own retry layer, or
by an application replaying an interrupted call — and a retry that reused
the same key another write had already used, or that a previous attempt of
the same write had already used, would risk one upload silently replacing
another's bytes.

Two further forces bear on how the upload is issued. A maintenance sweep
that walks the bucket to find an object whose row is gone needs a way to
ask DynamoDB "which row was this for?" without parsing the object key —
AWS's own guidance for this layout is to carry the item's primary key as S3
object metadata
(https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html).
And S3 supports a conditional write that refuses to create an object under
a key that already exists.

## Decision

We give every write its own id — a store put's revision, a checkpoint
put's ULID, a `putWrites` call's write group, a history message's ULID —
and build each offloaded object's key from that id, so no other write, and
no other attempt of the same write, ever names the same key. We upload with
`If-None-Match: *`, which asks S3 to refuse the write if an object is
already there, and treat that refusal — `PreconditionFailed`/412 — as
success: it means an earlier attempt of this same upload already stored the
bytes. Every upload also carries the row's DynamoDB partition and sort key
as user metadata, base64url-encoded, for an out-of-band sweeper to read.

## Consequences

Positive. A retried upload can never overwrite another write's object or
silently replace what an earlier attempt of itself already stored — the
guarantee is enforced by S3 on every request, not by this package
remembering which attempts it has already made.
`docs/evidence/s3-conditional-create.md` records both the refusal this
package checks for (E-7) and that racing conditional creates of one key leave
exactly one winner, every loser refused rather than overwriting it (E-8), so
the guarantee is verified against the service rather than only against
documentation. The backlink metadata makes an
orphaned object identifiable without decoding the key.

Negative. Every write that might offload a payload must mint an id even
when nothing about the write would otherwise need one, and the condition
costs an extra check S3 performs on every request, though no extra
permission: `s3:PutObject` already covers it. A write whose own upload
lands but whose retry then times out waiting for the response still
consumes one attempt of the write's retry budget establishing what the
condition already guarantees.

Neutral. The per-write id, not the conditional check, is what makes two
writes of identical bytes store two separate objects rather than
deduplicating to one; the condition alone only ever protects one write's
own key from being written twice.
