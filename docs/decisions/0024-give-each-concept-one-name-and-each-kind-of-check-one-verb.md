# 24. Give each concept one name and each kind of check one verb

## Status

Accepted.

## Context

The source used three words for one DynamoDB row — `item` (`ChatMessageItem`,
`buildStoreItem`, the document client's `DocItem`), `record` (`StoreItemRecord`,
`persistRecord`) and `row` — while `item` is also the name of what the
LangGraph store holds, its `Item`. `backend` named two unrelated things: the
store's `VectorBackend`, an external index a caller plugs in, and the
history's `SessionBackend`, the multi-session history a single-session adapter
wraps. And after record 21 fixed `parse*` and `assert*`, fourteen functions
still did one of those two jobs as `narrow*`, `require*`, `check*` or
`checked*`. The coding guidelines this package follows ask for one term per
concept, used from conversation down into the source (rule 35), and for a
name to change everywhere at once (rule 37).

## Decision

A DynamoDB row is a `row` in every module-level name: `AttributeMap` for a row
or key nothing has checked yet, `MessageRow`, `SessionRow`,
`CheckpointMetaRow`, `StoreItemRow`. `item` names only the store's `Item`, so it
appears in a name only under `src/store/`. `record` is not a noun anywhere in
`src`. `backend` names only the store's vector backend: the history's type is
`MultiSessionHistory`, and `SessionBackend` stays exported as a deprecated
alias of it until the next major release. The adapter's constructor parameter
keeps the name `backend`, because the refusal of a bad one names that field
and a caller can observe it. A function that returns the value it checked is a
`parse*` — a stored row's parser, which answers `undefined` for a row that is
not this adapter's, included — and one that returns nothing is an `assert*`;
`validate*`, `narrow*`, `require*`, `check*` and `checked*` are retired.

`test/static/domain-terms.test.ts` reads every module-level name in `src` and
`test/static/check-names.test.ts` every function name.

## Consequences

Positive. One word per thing: a search for `Row` finds every row type, and
`backend` always means the index a store caller configures.

Negative. The renames touched over a hundred test files. Log and error
messages still say "item" where they did — "not a checkpoint meta item" —
because a caller can observe them and changing them is a behaviour change of
its own. The guard reads names, not prose, so a comment can still call a row
an item. The deprecated alias is one more exported name until it is removed.

Neutral. The public option `maxScanItems` and the AWS API's own names
(`TransactWriteItems`, `BatchWriteItem`) keep theirs.
