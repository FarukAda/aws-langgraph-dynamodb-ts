# 13. Let only library errors cross the public boundary

## Status

Accepted.

## Context

A public method's implementation calls through several internal layers —
validation, the DynamoDB or S3 SDK, the retry classifier, the codec — each
of which can fail in its own vocabulary: a bare `TypeError`, an AWS SDK
exception, an error this package itself raises deliberately. A caller
catching what a public method rejects with needs one vocabulary to branch
on, not several, and needs to be able to tell "this package refused your
input" from "the SDK threw something this package did not anticipate"
without inspecting a stack trace.

`instanceof` cannot be that mechanism. Two copies of this package in one
dependency tree — an application depending on it directly and again
through a transitive dependency — produce two distinct classes from the
same source, so an error built by one `instanceof`-fails against the
other's class, and an error crossing a realm boundary keeps its properties
while losing its prototype chain entirely.

## Decision

We wrap every public method in `guardPublic` or, for a method that returns
a stream, `guardPublicIterable` (`src/shared/errors/boundary.ts`), applied
once at the method itself so internal code stays free to rethrow SDK
errors verbatim — which the retry classifier depends on being able to
inspect. Whatever a public method's implementation throws, the guard
normalises: a value that is already one of this package's own errors
passes through unchanged, since its code was assigned closer to the
failure and is more specific; anything else is wrapped as `UpstreamError`
naming the operation. Detection is by a non-enumerable symbol brand
(`isDynamoDBLangGraphError`, `src/shared/errors/base-error.ts`), checked
with `in`, and by the `code` a caller branches on — never `instanceof`,
which the `no-instanceof` ESLint rule bans repository-wide. The typed
errors themselves (`ValidationError`, `ConflictError`,
`RetryExhaustedError` and the rest in `src/shared/errors/errors.ts`) are
JavaScript subclasses of `DynamoDBLangGraphError` for exactly this reason:
detection never walks that hierarchy, only the brand and the `code`.
`test/static/guarded-methods.test.ts` walks the source and fails the build
for any exported method whose body is not, in its entirety, a single
guarded call.

## Consequences

Positive. A caller of any public method sees exactly one family of
rejections, whatever failed underneath it, and can branch on `code` and
structured `context` without needing to know which internal layer a
failure originated in. The brand-based detection is correct across two
installed copies of this package and across a realm boundary, where
`instanceof` would silently fail in both cases.

Negative. Every public method must be wrapped, and nothing but the static
test catches a new one added without the guard; the guard also costs a
`try`/`catch` frame on every public call, including the overwhelming
majority that succeed. A genuinely unexpected internal error is reported
as `UpstreamError` alongside an ordinary SDK failure, so a caller cannot
distinguish "this package has a bug" from "the SDK failed in a way this
package did not model" from the code alone. The error *class* hierarchy
this decision currently relies on — subclasses of `DynamoDBLangGraphError`,
detected by brand rather than by `instanceof` — is itself under review; a
later record will supersede the part of this one that describes that
shape, without changing the boundary rule itself.

Neutral. Wrapping happens only at the public boundary, so an internal
caller several layers deep still sees the SDK's own exception shape
directly, which is deliberate: the classifier and the internal read-back
logic both depend on inspecting that shape rather than a wrapper around
it.
