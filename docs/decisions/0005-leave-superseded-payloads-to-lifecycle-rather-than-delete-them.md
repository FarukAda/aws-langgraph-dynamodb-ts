# 5. Leave superseded payloads to lifecycle rather than delete them

## Status

Accepted.

## Context

An overwrite, a delete or a failed write can all leave an S3 object nothing
still needs: the payload a checkpoint or store item used to hold, or an
upload from an attempt that never committed. S3 and DynamoDB are not
transactional with each other, so no single mechanism can tell, with
certainty and in real time, whether a given object is safe to remove —
verifying costs a re-read, and a re-read can itself race a concurrent
writer. This package's compare-and-swap loops verify what they can before
deleting, but the cases where they cannot — a bounded retry budget
exhausted under contention, a best-effort delete that itself fails, a write
whose own outcome could not be confirmed — are exactly where this decision
applies: delete anyway, on the chance the object is genuinely unreferenced,
or leave it. The two failure directions are not symmetric. An object left
behind that nothing references is wasted storage, recoverable by
inspection. An object deleted that a live row still names fails every
future read of it, with no way back once the delete has gone through.

## Decision

We never delete an object as the only defense against that ambiguity:
every delete this package issues is either unconditional because a
compare-and-swap first confirmed the row no longer holds that write, or
explicitly best-effort and logged, never required for correctness. Each of
the three adapters exposes `ensureS3LifecycleRule()` — the checkpointer's
routed through `ensureS3Lifecycle()` — which provisions an S3 lifecycle
rule expiring objects under the adapter's key prefix on the configured TTL,
plus a second rule reclaiming the delete markers a release leaves on a
versioned bucket, and reports the bucket's versioning state rather than
requiring it. On a versioned bucket a release does not erase the payload
immediately; it survives as a noncurrent version behind a delete marker for
a grace window before the lifecycle rule reclaims it —
`docs/evidence/s3-versioning-and-lifecycle.md` records that a prior version
stays readable by id after a delete (E-10), that `GetBucketVersioning`
distinguishes the three states this decision reports on (E-9), and that
suspended versioning protects nothing written after the suspension (E-12).
A separate script, `scripts/find-stranded-payloads.mjs`, walks that grace
window and reports a row that still names a released object; it ships in
the repository rather than the published package, with no `bin` entry,
because its command line is a tool a maintainer runs a handful of times,
not a public surface this package's versioning promises would then cover.

## Consequences

Positive. No write's cleanup can delete an object a live row still needs on
the strength of a guess, because a write that cannot verify what it would
delete simply does not delete it. Bucket versioning turns "delete" into
"make noncurrent, then expire later," so a release made in error is
recoverable for the grace window, and the lifecycle rules bound how long an
object nothing gets around to deleting survives, regardless.

Negative. This decision accepts orphaned objects as a normal outcome:
pathological contention, a failed best-effort delete or an unverifiable
write all leave one behind, on purpose, and only the lifecycle rule or the
sweep script recovers the storage. A deployment that never configures a
TTL, and so never calls `ensureS3LifecycleRule()`, has no backstop at all.
The sweep itself only sees a versioned bucket, and only within the grace
window before S3 reclaims the delete marker; a strand older than that, or
on an unversioned bucket, is invisible to it.

Neutral. Keeping the sweep script out of the package's `bin` trades away
discoverability: an operator who needs it must know to look in the
repository rather than finding it through `npm ls` or the package's own
command surface.
