[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillResult

# Interface: BackfillResult

Defined in: shared/dynamodb/backfill-index.ts:13

What one pass of the backfill did, and where to resume.

## Properties

### indexed

> **indexed**: `number`

Defined in: shared/dynamodb/backfill-index.ts:17

Rows given index keys.

***

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: shared/dynamodb/backfill-index.ts:24

Opaque; absent when the table is fully walked. Pass it back to continue —
the pass is resumable, so a large table can be backfilled in bounded runs.

***

### scanned

> **scanned**: `number`

Defined in: shared/dynamodb/backfill-index.ts:15

Rows the scan evaluated.

***

### skipped

> **skipped**: `number`

Defined in: shared/dynamodb/backfill-index.ts:19

Rows no listing reaches, so no keys were written.
