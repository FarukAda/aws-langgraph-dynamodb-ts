# 19. Raise one error class and classify AWS failures in one place

## Status

Accepted. Supersedes the part of [13](0013-let-only-library-errors-cross-the-public-boundary.md) that describes a class hierarchy and `UpstreamError`.

## Context

This package raised ten error classes: a base class and nine subclasses, one of
which, `UpstreamError`, wrapped every failure that came from below with a single
code. Callers were told to branch on `code` and to recognise errors by a brand
rather than `instanceof`, because `instanceof` fails across two installed copies
of the package and across realms. The subclasses therefore added nothing a
caller could rely on except the fields a few of them carried, and they invited
the test that does not work.

`UpstreamError` told a caller that something below failed and nothing about
what to do: a throttle, an expired credential, a missing table and a bug in a
caller's own vector backend all arrived as `UPSTREAM`. Meanwhile the knowledge
of what an AWS failure means was spread over the retry classifier's token list,
S3's longer token list, and fourteen call sites comparing an exception name, a
cancellation reason code or an unbranded `code` field of their own — two of
them comparing a class name.

## Decision

We raise one class, `DynamoDBLangGraphError`, carrying a `code`, a `context`,
a `cause` and, for the two codes that report more than an identifier or a count
(`BATCH_WRITE_INCOMPLETE`, `COMPENSATION_FAILED`), `details` whose type the code
selects. `isDynamoDBLangGraphError` narrows to a union discriminated by `code`,
so reading `details` needs no cast.

We classify every failure that is not the package's own in one module,
`src/shared/errors/classify.ts`, by the exception's name, its HTTP status, its
Node network code and, for a cancelled transaction, its reasons. It assigns one
of `THROTTLED`, `SERVICE_UNAVAILABLE`, `CONTENTION`, `ACCESS_DENIED`,
`NOT_FOUND`, `AWS_REJECTED`, `CONDITION_CONFLICT`, `ABORTED`,
`AWS_REQUEST_FAILED` or `UNEXPECTED_ERROR`, which replace `UPSTREAM`. Each name
in its table is declared by the installed SDK or cited from AWS's error pages,
and a static test fails on any other. The retry layer's default tokens are
derived from the same table. Call sites recognise a library error with
`hasErrorCode` and an AWS error with the classifier; a static guard fails a
name compared anywhere else.

A new code is added only when a caller would act on it differently from every
existing one.

## Consequences

Positive. One `catch` and a `switch` on `code` is the whole error-handling
story, and the codes say what to do. What an AWS failure means is decided in
one place against cited sources, and the retry layer's default tokens are
derived from the same table, so the two share one list of transient names.
They still differ at two edges. The retry layer retries anything carrying the
SDK's `$retryable` trait, which the classifier does not read, so an error
carrying it with a name the table does not know and a status that is not
transient is retried, while the classifier, asked about the same error, answers
`AWS_REQUEST_FAILED` rather than a retryable code. And the retry layer walks
the cause chain matching `errno` and `syscall` as well as `name` and `code`,
where the classifier reads one error's `name`, `code` and status only.

Negative. This breaks every caller that imported a subclass or read one of
their fields; the CHANGELOG maps each to its replacement. The public boundary
cannot tell where a failure came from, so a network failure in a caller's own
vector backend is `SERVICE_UNAVAILABLE`, as an AWS one is, though without an
`awsErrorName`. Two codes carry `details`; a caller wanting exhaustiveness over
`ErrorDetailsByCode` pays when a third arrives.

Neutral. Record 14's retry order and bounds are unchanged; only the source of
its default token list moved, and S3 now shares DynamoDB's list.
