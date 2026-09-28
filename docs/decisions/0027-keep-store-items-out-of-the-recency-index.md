# 27. Keep store items out of the recency index

## Status

Accepted.

## Context

Record 8 put three listings on the recency index — `history.listSessions()`,
and `saver.list()` and `store.search([])` without a scoping root — and every
row those listings read was given index keys. The store's half never
happened: a rootless `store.search([])` and a `listNamespaces()` without a
prefix root stay table scans, because a namespace listing needs every row
and a search filters on the value, neither of which a recency order serves.
The store still wrote `gsi1pk`/`gsi1sk` on every item, still accepted
`indexName` and `indexShards`, and read neither. With the index's documented
`ALL` projection, every store write was written twice for a listing that
does not exist.

## Decision

Store rows carry no recency-index keys (`buildStoreRow`,
`src/store/internal/rows.ts`), the index has two tags, `CHKPT` and `SESS`
(`src/shared/dynamodb/recency-index.ts`), `backfillRecencyIndex` leaves store
rows alone, and the store refuses `indexName` and `indexShards` as options it
does not read. Record 8 is superseded for the store; its decisions for the
checkpointer and the chat history stand. A store row written by
`1.0.0-rc.2` keeps its keys until it is next put, which rewrites the whole
item without them; nothing reads them meanwhile.

## Consequences

Positive. A store write on a table carrying the index costs one write again,
not two, and the store's options say what it reads.

Negative. A store configured with `indexName` or `indexShards` — accepted,
and ignored, by `1.0.0-rc.2` — now fails at construction and must drop them.
If a recency listing of store items is ever wanted, it needs its own record.

Neutral. Checkpoint and session listings are unchanged.
