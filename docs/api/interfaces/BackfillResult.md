[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillResult

# Interface: BackfillResult

Defined in: [backfill/backfill.ts:300](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L300)

What one pass of the backfill did, and where to resume.

## Properties

### indexed

> **indexed**: `number`

Defined in: [backfill/backfill.ts:304](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L304)

Rows given index keys.

***

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: [backfill/backfill.ts:314](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L314)

Opaque; absent when the table is fully walked. Pass it back to continue —
the pass is resumable, so a large table can be backfilled in bounded runs.

***

### scanned

> **scanned**: `number`

Defined in: [backfill/backfill.ts:302](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L302)

Rows the scan evaluated.

***

### skipped

> **skipped**: `number`

Defined in: [backfill/backfill.ts:309](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L309)

Rows this run wrote no keys for: one no listing reaches, and one whose
write the condition refused because it already has keys or is gone.
