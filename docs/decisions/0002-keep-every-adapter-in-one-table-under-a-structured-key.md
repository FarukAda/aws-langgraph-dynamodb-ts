# 2. Keep every adapter in one table under a structured key

## Status

Accepted.

## Context

This package ships three adapters — a checkpointer, a store and a chat-message
history — and an application may use one, two or all three. DynamoDB bills
and provisions per table, so a deployment that wants one table to back every
adapter needs their rows to coexist without colliding, while a deployment
that wants separate tables must not be forced into one.

Each adapter also has its own idea of what a row's identity is: the
checkpointer distinguishes a metadata row, a checkpoint payload and a
pending write, addressed by thread, namespace, checkpoint id, task and a
write index that can be negative for a handful of reserved channels
(`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`); the store
addresses an item by an arbitrary-depth namespace plus a key; chat history
addresses a session's metadata row and its ordered messages. A single
partition-key/sort-key pair has to carry all of that without one adapter's
key colliding with another's, and a value a caller supplies — a `thread_id`
reused as a `sessionId`, say — is an ordinary thing to do, not a
misconfiguration to guard against.

## Decision

We give every row the same two attributes, a string `PK` and a string `SK`,
and let each adapter compose its own key from them. Every partition key
opens with an adapter tag (`CHKPT#`, `STORE#`, `HIST#`) whose three tags
differ in their first character, so no two adapters' partitions can ever
collide. Within a partition, `#` separates structural segments — an item
kind, a namespace, an id, a task, an index, a channel — so a sort key can be
read back into its parts and matched with `begins_with`. The checkpointer's
write index is offset by a fixed constant (`WRITE_INDEX_OFFSET`) and
zero-padded to a fixed width before it joins the key, so the reserved
negative channels and the ordinary positional ones both sort numerically as
plain strings.

## Consequences

Positive. One table can back all three adapters, or a deployment can give
each its own — the choice costs nothing in the key design, only the
`tableName` an adapter is constructed with. A read never has to consult a
second attribute to know what kind of row it is looking at: the sort key's
own prefix says so, and `begins_with` on that prefix selects exactly one
adapter's rows or one kind of row within it.

Negative. `#` becomes a reserved character no caller-supplied identifier may
contain. The write-index offset is a fixed constant rather than derived at
run time from the peer package's own special-channel map, so a peer release
that added a more negative channel than this package currently encodes
would need the offset widened in step; a static test pins the current
headroom so that drift is caught rather than silently miscoding a key.

Neutral. The structural rule cuts both ways on a shared table: it is what
lets `deleteThread()` and `history.clear()` delete only the rows their own
adapter's tag and kind own, leaving another adapter's data untouched, but
it also means every adapter pays the cost of parsing and validating that
structure on every key it builds or reads.
