# 8. Make the recency index opt-in and sharded

## Status

Accepted.

## Context

Three listings — `history.listSessions()`, and `saver.list()` and
`store.search([])` without a scoping root — read across every partition in
the table, because nothing about a thread-less or namespace-less request
names a partition to `Query`. Without a secondary index the only way to
answer one is a table `Scan`, which costs read capacity for every row it
evaluates rather than every row it returns and grows with the whole table's
size, not with the size of the answer.

A GSI would answer these newest-first without a scan, but mapping every
row's recency onto one partition key is the hot-partition anti-pattern AWS
names directly: every write across the whole table would then contend for
the same GSI partition. And a table already carrying rows written before
any such index existed cannot simply start using it — a row without the
index's keys is invisible to a query against it, though every other read
still finds the row exactly as before.

## Decision

We offer a sharded recency GSI, on `gsi1pk`/`gsi1sk`
(`src/checkpointer/internal/list-rows.ts`,
`src/shared/dynamodb/index-keys.ts`), only when an adapter is constructed
with `indexName`. `gsi1pk`/`gsi1sk` are written on every row a listing
crosses partitions for — checkpointer META, store items, history SESSION —
whether or not the table defines the index at all, so enabling `indexName`
later needs only a backfill, never a rewrite of existing rows. Their
partition key is spread across `indexShards` shards (default 8, ceiling
1024) rather than one, and a listing reads all of a run's shards at once,
up to `readConcurrency` in flight, following each newest-first. A table
that already has rows predating the index runs
`backfillRecencyIndex()` (`src/shared/dynamodb/backfill-index.ts`) first —
a conditional `UpdateItem` per row, safe to run against a live table and
safe to re-run, that gives an existing row its keys without ever
overwriting a live adapter's own write or resurrecting a row that has since
been deleted.

## Consequences

Positive. A deployment that never sets `indexName` pays nothing for this
decision beyond the two small extra attributes on rows it lists across
partitions; one that does gets those three listings off a full table scan
without concentrating every write in the table onto one GSI partition.
Backfilling is separated from enabling, so a table can be indexed while
live and the index turned on only once every row is covered.

Negative. `indexShards` is fixed once the adapters and the backfill agree
on it — changing it moves every row's shard and needs another full
backfill — and a mismatch between what the adapters use and what
`backfillRecencyIndex` was run with looks exactly like the rows being
missing, with no error to say so. The index still returns every tenant's
rows by construction, the same as the scan it replaces, so it is no
narrower a surface for a multi-tenant deployment to reason about.

Neutral. Opt-in means whether the table carries the index is a deployment
fact this package does not probe for; forgetting to set `indexName` on a
table that has been backfilled costs nothing but the scan it was meant to
avoid, while setting it on a table that has not been backfilled hides
pre-existing rows from exactly the listings meant to find them.
