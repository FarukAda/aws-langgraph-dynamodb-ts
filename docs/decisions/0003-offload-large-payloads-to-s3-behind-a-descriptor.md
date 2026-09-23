# 3. Offload large payloads to S3 behind a descriptor

## Status

Accepted.

## Context

A checkpoint, a store item's value and a chat message are all
caller-supplied data of unbounded size, while DynamoDB caps a whole item —
every attribute name and value combined — at 400 KB
(https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).
An application whose state genuinely grows past that has two unattractive
options if this package does nothing: fail the write with a raw
`ValidationException`, or restructure its data model around a limit that has
nothing to do with its domain.

AWS's own guidance for this shape of problem is to keep the large value
elsewhere and store a reference to it in the item
(https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html,
*Best practices for storing large items and attributes in DynamoDB*). Doing
that changes what a read has to do — fetch a second object, over a second
network hop, on a different failure mode — so it is worth paying only above
some size, and every payload below it should stay a plain attribute.

## Decision

We offload a serialized payload to S3 once it reaches a configurable
threshold (`thresholdBytes`, default 350 KB — 50 KB of margin under
DynamoDB's cap, left for the store's inline vector embedding and the item's
other attributes) and store a `PayloadDescriptor` in its place: a small,
versioned record naming where the bytes live, `INLINE` with the bytes
attached or `S3` with a key. With no S3 offloader configured, a payload that
would exceed the inline ceiling (`MAX_INLINE_PAYLOAD_BYTES`, DynamoDB's
400 KB less 8 KB of headroom for the item's keys and attribute names) is
refused before the write, typed, rather than reaching DynamoDB as a raw
`ValidationException`. Every reader checks a descriptor's shape and schema
version before trusting it, so a row this version cannot make sense of is
reported rather than misread.

## Consequences

Positive. An application's payload size is bounded by what it configures,
not by DynamoDB's item limit, and a payload that would have failed the
write now fails it earlier and with a message that says why, or does not
fail at all once offload is configured. A payload well under the threshold
pays nothing extra.

Negative. A payload near the threshold now depends on everything else that
shares the item — the store's inline vector embedding chief among them — to
stay under DynamoDB's cap, which makes the margin a budget an application
has to reason about. Reading an offloaded payload costs a second round
trip, to S3, that an inline one never pays, with its own failure modes this
package has to classify and surface.

Neutral. The descriptor is a compatibility contract of its own, separate
from the payload it points at: it carries a schema version so a future
change to its shape can be introduced without breaking rows an older
release wrote, and an unknown location or a version ahead of what this
reader understands is refused rather than guessed at.
