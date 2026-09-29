# 28. Ignore keys LangGraph adds to option objects it defines

## Status

Accepted.

## Context

Record 21 parses caller input once, at the boundary, and every option object
this package read was held to an exhaustive key list: a key the list did not
name was refused as `VALIDATION` naming `options.<key>`, because a misspelt
option otherwise runs silently on the default the caller believes they
overrode.

Four of those option objects are not this package's own. `saver.list`'s
options are LangGraph's `CheckpointListOptions`; `getDeltaChannelHistory`'s
are the object `BaseCheckpointSaver` declares for it; `store.search`'s are
`SearchOperation`'s filter and paging fields; and `store.listNamespaces`'
are the object `BaseStore.listNamespaces` declares. LangGraph is the caller
of most of these calls, not the application: `getStateHistory` hands its own
options to `checkpointer.list`, and the delta-channel machinery calls
`getDeltaChannelHistory({ config, channels })` itself.

The peer ranges (`@langchain/langgraph-checkpoint` `^1.1.5`) admit every
minor release LangGraph ships. A minor that adds an optional field to one of
these objects would have made every call that passes it fail with
`VALIDATION`, for every user, the moment they upgraded LangGraph, while this
package's own CI stayed green: the conformance tier runs against the newest
release only when a change is pushed. `store.batch()`, the path LangGraph's
runtime uses for the store, never refused unknown fields at all.

## Decision

The four option objects LangGraph defines are held to being objects, and
every key this version reads is still validated, but a key it does not read
is ignored rather than refused. Option objects this package defines — the
constructors' options, the per-call `{ signal }` objects, `getMessages`'
options, the history window, the factory's and `backfillRecencyIndex`'s —
stay exhaustive.

What the refusal bought is kept at compile time instead: `test/types` pins
each of the four upstream types' key sets, so the day LangGraph adds a key,
the type check fails. A weekly workflow (`latest-peers.yml`) runs the type
check, the unit tier and the conformance tier against the newest LangGraph
and LangChain releases, so that failure reaches a maintainer rather than a
user, and the maintainer decides whether this package should read the new
key.

## Consequences

Positive. A LangGraph release that adds an option can no longer break a call
LangGraph makes, and the four calls now behave like `store.batch()`. The
weekly run surfaces any other upstream change, typed or behavioural, within a
week of its release.

Negative. On these four calls a misspelt key in plain JavaScript is ignored
rather than refused; TypeScript's excess-property check still catches it in
an object literal. A key LangGraph adds is ignored until a release of this
package reads it, which for an option that changes behaviour means the
behaviour is not applied meanwhile.

Neutral. Record 21 stands: input is still parsed once, at the boundary, into
the types only a parser builds; only what counts as a refusal changes for
these four objects.
