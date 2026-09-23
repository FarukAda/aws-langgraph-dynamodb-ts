# 10. Store every channel value regardless of `newVersions`

## Status

Accepted.

## Context

`BaseCheckpointSaver.put` declares a `newVersions` parameter naming which
channels changed since the parent checkpoint, and a saver that stores only
those channels — carrying the rest forward implicitly from the parent on
read — writes less per put and matches what the parameter appears to be
for. `MemorySaver.put`, the reference implementation, does not do this: it
takes the parameter and stores the whole checkpoint regardless
(`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:206`), which
record 9 already treats as the behaviour to match absent a reason not to.

Here there is a concrete reason beyond parity. LangGraph passes an empty
`newVersions` — `{}` — both when forking a checkpoint and when writing an
empty-checkpoint update (`@langchain/langgraph@1.4.13`
`dist/pregel/index.js:668` and `:613`). A saver that narrows storage to the
channels `newVersions` names stores nothing at all on either call, which
silently drops the caller's state rather than merely storing it
inefficiently.

## Decision

We store every channel value a checkpoint carries and ignore `newVersions`
entirely. `putCheckpoint` (`src/checkpointer/actions/put.ts`) accepts the
parameter, because `BaseCheckpointSaver.put` declares it and a saver must
match that signature, and never reads it. This is recorded as V-10 in the
README's *Differences from the reference implementations* table, and
`test/conformance/validation.conformance.test.ts` — which runs LangChain's
own published checkpointer validation suite — skips that suite's one test
for storing only the channels `newVersions` names, under the same
`[because …]` exemption the suite itself already grants `MemorySaver` and
the first-party MongoDB and SQLite savers, on the same grounds: none of
them store channel deltas either.

## Consequences

Positive. A fork of a checkpoint and an empty-checkpoint update both keep
the state the caller actually holds, where narrowing by `newVersions` would
have silently written nothing for either. The rule needs no case analysis
at the write site — every put stores everything it was given, so there is
no `newVersions` shape that changes what lands.

Negative. Every put writes the checkpoint's full channel set, never a
delta, so a checkpoint carrying many large channels pays for all of them on
every put even when only one changed — the cost this package accepts in
place of the risk of silently dropping state. The `CHANGELOG.md`
`1.0.0-rc.2` entry records the same reasoning as the fix it is: an earlier
narrowing implementation existed and was found to drop state on exactly the
two calls above.

Neutral. `newVersions` remains part of the public method signature, unread,
because the type this saver implements requires it; a caller that
constructs one to pass in is not wasting anything this package uses, but is
also not narrowing what gets stored by doing so.
