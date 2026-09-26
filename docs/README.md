# Documentation

The [README](../README.md) is the entry point for using the package. This
directory holds everything that would clutter it: [the in-depth guide](guide.md)
the README's summaries link out to, the generated API reference, the decision
records and live-AWS evidence that explain *why* the code is shaped the way
it is, and the coding guidelines the codebase follows. The
[examples](../examples/README.md) directory runs the library against real AWS
instead of documenting it.

## Start here

Start with the [README](../README.md), which covers installation,
configuration and day-to-day use. The [quick start](../README.md#quick-start)
installs the package and runs a minimal agent against a table you already
have, and the [usage examples](../README.md#usage-examples) walk through the
checkpointer, the store, chat history and the factory. The
[configuration reference](../README.md#configuration-reference) lists every
option with its default and ceiling; [error handling](../README.md#error-handling) documents the
`DynamoDBLangGraphError` shape and every `ErrorCode`;
[known limitations](../README.md#known-limitations) collects what DynamoDB, S3
and this package cannot do; the [API reference](../README.md#api-reference)
lists every public method with its signature; and
[operations](../README.md#operations) covers limits, per-call costs,
monitoring and what can still go wrong in production.

## In-depth guide

[guide.md](guide.md) is where the README's summaries send you for the
mechanism behind a promise: the compare-and-swap and request-token machinery
behind S3 offload, what a partition delete promises and what it costs, search
and vector-index consistency, checkpointer and chat-history semantics, the
request-unit cost of every call with a worked example, what can still go
wrong between a DynamoDB row and its S3 payload and the sweep that finds a
stranded one, and the on-disk layout and error/version guarantees behind
[Versioning and compatibility](../README.md#versioning-and-compatibility).
Its samples are compiled against `src` on every CI run, like the README's.

## API reference

[api/README.md](api/README.md) is the full generated index. It is built from
the `src` doc comments by `npm run docs` (`typedoc.json` writes it to
`docs/api` with `cleanOutputDir: true`, so nothing else under `docs/` is
touched by a regenerate), and CI regenerates it on every push and fails the
build if the committed output differs from a fresh run.

The adapters:

- [DynamoDBSaver](api/classes/DynamoDBSaver.md) — the checkpoint saver
- [DynamoDBStore](api/classes/DynamoDBStore.md) — the long-term memory store,
  with semantic search when an embeddings model is configured
- [DynamoDBChatMessageHistory](api/classes/DynamoDBChatMessageHistory.md) —
  chat message history for every session, each method taking a `sessionId`
- [DynamoDBSessionChatMessageHistory](api/classes/DynamoDBSessionChatMessageHistory.md) —
  the single-session LangChain adapter `forSession` returns, for
  `RunnableWithMessageHistory`
- [DynamoDBFactory](api/classes/DynamoDBFactory.md) — builds any combination
  of the three adapters, sharing one client
- [DynamoDBLangGraphError](api/classes/DynamoDBLangGraphError.md) — the one
  error class every adapter raises

Also worth knowing about: [ErrorCode](api/enumerations/ErrorCode.md) (every
code an adapter can raise), [backfillRecencyIndex](api/functions/backfillRecencyIndex.md)
(the maintenance operation that adds the recency index to rows written before
it was enabled), [JSON_SERDE](api/variables/JSON_SERDE.md) (the plain JSON
serializer the store and chat history use by default, and which a saver can
be given in place of LangGraph's `JsonPlusSerializer`),
[isDynamoDBLangGraphError](api/functions/isDynamoDBLangGraphError.md) (whether
a caught value is one of this package's errors), and
[redactLogger](api/functions/redactLogger.md) and
[redactSecrets](api/functions/redactSecrets.md) (redaction for a logger and
for a single value). The README's [API reference](../README.md#api-reference)
summarises every method in one table per class.

## Why it is built this way

- [Decision records](decisions/README.md) — 24 records of decisions that are
  expensive to reverse: what the situation was, what was decided, and what it
  costs.
- [Evidence](evidence/README.md) — 17 claims about DynamoDB or S3 behaviour
  that AWS documents incompletely or not at all, each backed by a live test
  that fails if AWS changes the behaviour, recorded across 9 claim files.
- [Coding guidelines](coding-guidelines.md) — the conventions the codebase
  follows.

## Running it against AWS

[examples/](../examples/README.md) runs the library against real AWS —
DynamoDB, and Bedrock for two of the four scripts — rather than documenting
it. See that guide for what each script does, what it costs, and how to clean
up afterwards.

## Contributing and support

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the development workflow;
[SUPPORT.md](../SUPPORT.md) says where to ask questions;
[SECURITY.md](../SECURITY.md) covers reporting a vulnerability;
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) sets expectations for the
project's spaces; and [CHANGELOG.md](../CHANGELOG.md) lists every released
change.

## How these documents are kept true

- `npm run check:docs` type-checks every TypeScript sample in the README,
  [the guide](guide.md) and CONTRIBUTING.md against `src`, so a documented
  call whose signature changed fails the build instead of a reader.
- `npm run check:links` resolves every relative link and `#anchor` across the
  hand-written documents (this file included), so a moved file or a renamed
  heading is caught before it reaches a reader.
- CI's "Regenerate docs/api and fail on drift" step re-runs `npm run docs` and
  fails if the committed `docs/api` differs, so the API reference above
  cannot go stale.
- Static guards read the README directly and fail if it disagrees with the
  code, among them `test/static/error-codes.test.ts` (every `ErrorCode` member is
  documented), `test/static/log-events.test.ts` (every logged event is
  documented with the right level and fields), and
  `test/static/iam-actions.test.ts` (the IAM actions the README lists match
  the calls the code makes).
