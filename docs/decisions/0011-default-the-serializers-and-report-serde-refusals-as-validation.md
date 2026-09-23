# 11. Default the serializers, and report serde refusals as validation

## Status

Accepted.

## Context

The checkpointer, store and chat-message-history adapters each accept a
`serde` override, and each needs a default. `BaseCheckpointSaver` already
carries LangGraph's `JsonPlusSerializer`, which reconstructs a `Map`, a
`Set`, a `Uint8Array` or an allow-listed `langchain_core` class from an
`lc` constructor record a stored row carries — the row chooses which
constructor runs in the reading process, which `SECURITY.md` documents as
making write access to the table a code-path selection for every reader.
The store and chat-history adapters have no base class carrying a default
at all.

Whatever the configured serializer refuses to reconstruct — an `lc` record
naming a class outside its allow-list, most concretely — used to escape
unbranded and reach the caller as an `UpstreamError`, reporting a row's own
content as if it were an AWS failure and copying the stored record verbatim
into the error message. `history.getMessages` additionally dropped such a
message silently under its default `onCorruptMessage: 'skip'`, so the same
row made three adapters answer three different ways, one of them by simply
losing the turn.

## Decision

We default `DynamoDBSaver` to `JsonPlusSerializer` (inherited from
`BaseCheckpointSaver`, `src/checkpointer/types.ts`) and default
`DynamoDBStore` and the chat-history adapters to the exported `JSON_SERDE`
(`src/history/types.ts`), plain `JSON.parse` with no constructor
reconstruction. A stored payload the configured serializer declines to
rebuild — the bytes are intact, but the serializer refuses what they name —
is reported as `ValidationError` with `context.field: 'serde'` and the
serializer's own refusal as `cause`, on every adapter alike and regardless
of `onCorruptMessage`, rather than being classified as either an upstream
failure or corruption. `SECURITY.md`'s *Trust boundary* section documents
`JSON_SERDE` as the narrower, supported alternative for a checkpointer
whose table write access is not fully trusted.

## Consequences

Positive. A checkpointer keeps the richer round-trip an application
depends on unless it opts out, while the store and chat-history adapters
default to the narrower serializer that carries the smaller reconstruction
surface out of the box. A serializer's refusal is now the same reported
outcome everywhere it happens, distinct from a corrupted payload and from
an infrastructure failure, so a caller branches on one code rather than
three different failure shapes depending on which adapter it called.

Negative. `history.getMessages`'s default `onCorruptMessage: 'skip'` no
longer silently drops a serde refusal, which is the correct behaviour but
is also a stricter one than before: a session containing such a row now
fails that call outright unless the caller opted into `'skip'` meaning
exactly what it says. Switching an adapter's `serde` after rows already
exist changes how those existing rows read, since nothing on a row records
which serializer wrote it.

Neutral. `JsonPlusSerializer`'s allow-list is a property of the reading
process's import map, not of the payload: a row an application cannot read
today because a class is missing from its allow-list may read fine in a
process that imports it, and the `ValidationError` this decision raises
says exactly that rather than declaring the payload itself lost.
