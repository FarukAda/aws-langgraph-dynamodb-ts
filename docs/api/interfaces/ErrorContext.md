[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ErrorContext

# Interface: ErrorContext

Defined in: [shared/errors/base-error.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L10)

Structured, log-safe context attached to every library error. Identifiers
and counts only — never a payload or a credential.

## Properties

### attempts?

> `optional` **attempts?**: `number`

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L20)

Attempts made before a retry budget was exhausted.

***

### awsErrorName?

> `optional` **awsErrorName?**: `string`

Defined in: [shared/errors/base-error.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L31)

The AWS exception name of the failure underneath, when that failure was
AWS-shaped (it carried the SDK's `$metadata`, or a name the classifier
knows or that ends in `Exception`). Lifted off `cause.name` so a log line
or an alert can branch on it without walking `cause`.

***

### checkpointId?

> `optional` **checkpointId?**: `string`

Defined in: [shared/errors/base-error.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L24)

The checkpoint a checkpointer failure names.

***

### field?

> `optional` **field?**: `string`

Defined in: [shared/errors/base-error.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L16)

The option, argument or cap that failed validation or was exceeded.

***

### httpStatusCode?

> `optional` **httpStatusCode?**: `number`

Defined in: [shared/errors/base-error.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L35)

The HTTP status of the failed AWS response (`cause.$metadata.httpStatusCode`).

***

### key?

> `optional` **key?**: `string`

Defined in: [shared/errors/base-error.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L18)

The S3 object key involved, for offload failures.

***

### operation?

> `optional` **operation?**: `string`

Defined in: [shared/errors/base-error.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L14)

The public operation (`saver.put`, `store.batch`, …) or internal step that failed.

***

### requestId?

> `optional` **requestId?**: `string`

Defined in: [shared/errors/base-error.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L33)

The AWS request id (`cause.$metadata.requestId`), which AWS Support asks for.

***

### tableName?

> `optional` **tableName?**: `string`

Defined in: [shared/errors/base-error.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L12)

The DynamoDB table the operation targeted, when known.

***

### threadId?

> `optional` **threadId?**: `string`

Defined in: [shared/errors/base-error.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L22)

The thread a checkpointer failure belongs to.
