[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / backfillRecencyIndex

# Function: backfillRecencyIndex()

> **backfillRecencyIndex**(`options`): `Promise`\<[`BackfillResult`](../interfaces/BackfillResult.md)\>

Defined in: [shared/dynamodb/backfill-index.ts:134](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-index.ts#L134)

Give rows written before the recency index their index keys.

**Run this before setting `indexName` on any adapter.** A row without the
keys is not in the index, so enabling the index first would make every
pre-existing session, item and checkpoint silently vanish from the listings
that read it — the rows are still there, and every other read still returns
them, but a listing would not.

Safe to re-run and safe to run while adapters are writing: every write is
conditional on the row still being there and having no keys yet, so a row a
live adapter has already indexed is left exactly as it is, and a row deleted
after the scan found it stays deleted rather than being re-created by an
`UpdateItem`, which upserts.

`indexShards` must match what the adapters use. A mismatch puts rows on
shards no listing queries, which looks exactly like the rows being missing.

Accepts: `options` — validated in full before any read: only the keys
`BackfillOptions` declares; `tableName`, `indexShards` and the numbers in
`retry` by the adapters' rules; `signal` as their methods check it; a
`client` providing `scan` and `update`. `options.pageSize` — a positive integer,
default 100. `options.cursor` — from a previous run, to resume.
`options.maxPages` — how far one run goes, so a large table can be
backfilled in bounded slices. `options.indexShards` — must equal the
adapters' setting, and has their ceiling. `options.dryRun` — a boolean.
`options.signal` — cancels the run; `retry.signal` does so when there is no
top-level `signal`, and the top-level one wins when both are given.

Returns: how many rows were scanned and how many were given keys, plus a
`nextCursor` when the run stopped short of the end. An absent cursor means
the table is fully backfilled.

Throws: ValidationError naming the offending option, before any DynamoDB
call; RetryExhaustedError once a transient failure has used every attempt;
AbortError when `signal` fires, or `retry.signal` when no top-level `signal`
is given; UpstreamError wrapping any other error the scan or the writes
throw — this is the function's own error boundary, the same as every
adapter's public methods, so a caller's mistake never escapes as a bare
exception.

Guarantees: every write is conditional on the row still being there and
having no keys yet, so re-running is safe, running against a live table is
safe, a row a live adapter has already indexed is left exactly as it is, and
a row deleted between the scan and the write is never re-created.

## Parameters

### options

[`BackfillOptions`](../interfaces/BackfillOptions.md)

## Returns

`Promise`\<[`BackfillResult`](../interfaces/BackfillResult.md)\>
