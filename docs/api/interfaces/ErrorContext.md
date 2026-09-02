[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ErrorContext

# Interface: ErrorContext

Defined in: [shared/errors/base-error.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L9)

Structured, log-safe context attached to every library error. Identifiers
and counts only — never a payload or a credential.

## Properties

### attempts?

> `optional` **attempts?**: `number`

Defined in: [shared/errors/base-error.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L19)

Attempts made before a retry budget was exhausted.

***

### field?

> `optional` **field?**: `string`

Defined in: [shared/errors/base-error.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L15)

The option, argument or cap that failed validation or was exceeded.

***

### key?

> `optional` **key?**: `string`

Defined in: [shared/errors/base-error.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L17)

The S3 object key involved, for offload failures.

***

### operation?

> `optional` **operation?**: `string`

Defined in: [shared/errors/base-error.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L13)

The public operation (`saver.put`, `store.batch`, …) or internal step that failed.

***

### tableName?

> `optional` **tableName?**: `string`

Defined in: [shared/errors/base-error.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L11)

The DynamoDB table the operation targeted, when known.
