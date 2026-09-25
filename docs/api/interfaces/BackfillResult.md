[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillResult

# Interface: BackfillResult

Defined in: [backfill/backfill.ts:293](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L293)

What one pass of the backfill did, and where to resume.

## Properties

### indexed

> **indexed**: `number`

Defined in: [backfill/backfill.ts:297](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L297)

Rows given index keys.

***

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: [backfill/backfill.ts:307](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L307)

Opaque; absent when the table is fully walked. Pass it back to continue —
the pass is resumable, so a large table can be backfilled in bounded runs.

***

### scanned

> **scanned**: `number`

Defined in: [backfill/backfill.ts:295](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L295)

Rows the scan evaluated.

***

### skipped

> **skipped**: `number`

Defined in: [backfill/backfill.ts:302](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L302)

Rows this run wrote no keys for: one no listing reaches, and one whose
write the condition refused because it already has keys or is gone.
