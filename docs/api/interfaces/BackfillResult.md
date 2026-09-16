[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillResult

# Interface: BackfillResult

Defined in: [shared/dynamodb/backfill-types.ts:6](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L6)

What one pass of the backfill did, and where to resume.

## Properties

### indexed

> **indexed**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L10)

Rows given index keys.

***

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: [shared/dynamodb/backfill-types.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L17)

Opaque; absent when the table is fully walked. Pass it back to continue —
the pass is resumable, so a large table can be backfilled in bounded runs.

***

### scanned

> **scanned**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L8)

Rows the scan evaluated.

***

### skipped

> **skipped**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L12)

Rows no listing reaches, so no keys were written.
