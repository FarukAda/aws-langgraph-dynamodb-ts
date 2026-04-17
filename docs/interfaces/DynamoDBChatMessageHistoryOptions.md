[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Interface: DynamoDBChatMessageHistoryOptions

Defined in: [history/types/index.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L28)

Configuration options for DynamoDBChatMessageHistory

## Remarks

**TTL semantics — important:**

- The **session metadata** item's `ttl` attribute is refreshed on every
  `addMessage` / `addMessages` call, so `listSessions()` reflects a session as
  live as long as new messages keep arriving within `ttlDays`.
- Individual **message items** get a TTL stamped at write time and each
  expires independently. A long-lived session that ingests new messages every
  few days can develop gaps where old messages expire while newer ones
  persist.

If you need a strict "keep the whole conversation as long as it is active"
contract, set `ttlDays` significantly larger than your expected session
lifetime, or manage deletion yourself via `clear()`.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: [history/types/index.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L42)

Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [history/types/index.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L40)

Optional DynamoDB client configuration

***

### tableName

> **tableName**: `string`

Defined in: [history/types/index.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L30)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays?**: `number`

Defined in: [history/types/index.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L38)

Optional TTL in days for stored items (1-1825 days).

Metadata TTL is sliding (refreshed on every write). Per-message TTL is
fixed at each message's write time — see the class-level remarks for
implications on long-lived sessions.
