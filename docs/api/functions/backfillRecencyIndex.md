[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / backfillRecencyIndex

# Function: backfillRecencyIndex()

> **backfillRecencyIndex**(`options`): `Promise`\<[`BackfillResult`](../interfaces/BackfillResult.md)\>

Defined in: [shared/dynamodb/backfill-index.ts:131](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-index.ts#L131)

Give rows written before the recency index their index keys.

**Run this before setting `indexName` on any adapter.** A row without the
keys is not in the index, so enabling the index first would make every
pre-existing session, item and checkpoint silently vanish from the listings
that read it — the rows are still there, and every other read still returns
them, but a listing would not.

Safe to re-run and safe to run while adapters are writing: every write is
conditional on the row having no keys yet, so a row a live adapter has
already indexed is left exactly as it is.

`indexShards` must match what the adapters use. A mismatch puts rows on
shards no listing queries, which looks exactly like the rows being missing.

Accepts: `options.pageSize` — a positive integer, default 100.
`options.cursor` — from a previous run, to resume. `options.maxPages` — how
far one run goes, so a large table can be backfilled in bounded slices.
`options.indexShards` — must equal the adapters' setting.

Returns: how many rows were scanned and how many were given keys, plus a
`cursor` when the run stopped short of the end. An absent cursor means the
table is fully backfilled.

Throws: ValidationError naming `pageSize` or `cursor`; whatever the scan and
the writes throw.

Guarantees: every write is conditional on the row having no keys yet, so
re-running is safe, running against a live table is safe, and a row a live
adapter has already indexed is left exactly as it is.

## Parameters

### options

[`BackfillOptions`](../interfaces/BackfillOptions.md)

## Returns

`Promise`\<[`BackfillResult`](../interfaces/BackfillResult.md)\>
