[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ErrorCode

# Enumeration: ErrorCode

Defined in: [shared/errors/error-code.ts:2](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L2)

Stable, branchable classification for every error this library throws.

## Enumeration Members

### ABORTED

> **ABORTED**: `"ABORTED"`

Defined in: [shared/errors/error-code.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L23)

***

### ANCESTOR\_EXPIRED

> **ANCESTOR\_EXPIRED**: `"ANCESTOR_EXPIRED"`

Defined in: [shared/errors/error-code.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L10)

A checkpoint a delta channel still needs has expired, so the channel cannot
be reconstructed and the read refuses rather than returning a shorter value.

***

### BATCH\_WRITE\_INCOMPLETE

> **BATCH\_WRITE\_INCOMPLETE**: `"BATCH_WRITE_INCOMPLETE"`

Defined in: [shared/errors/error-code.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L13)

***

### COMPENSATION\_FAILED

> **COMPENSATION\_FAILED**: `"COMPENSATION_FAILED"`

Defined in: [shared/errors/error-code.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L24)

***

### COMPRESSION\_LIMIT

> **COMPRESSION\_LIMIT**: `"COMPRESSION_LIMIT"`

Defined in: [shared/errors/error-code.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L14)

***

### CONDITION\_CONFLICT

> **CONDITION\_CONFLICT**: `"CONDITION_CONFLICT"`

Defined in: [shared/errors/error-code.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L11)

***

### FORMAT\_UNSUPPORTED

> **FORMAT\_UNSUPPORTED**: `"FORMAT_UNSUPPORTED"`

Defined in: [shared/errors/error-code.ts:5](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L5)

A row or payload written in a format version newer than this package reads.

***

### PAYLOAD\_CORRUPT

> **PAYLOAD\_CORRUPT**: `"PAYLOAD_CORRUPT"`

Defined in: [shared/errors/error-code.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L20)

A stored payload's bytes do not match the form its row declares: the row
says gzip and they are not, or they are not the serializer's output. The
payload can never be read, so it is reported rather than retried.

***

### RESULT\_TRUNCATED

> **RESULT\_TRUNCATED**: `"RESULT_TRUNCATED"`

Defined in: [shared/errors/error-code.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L22)

***

### RETRY\_EXHAUSTED

> **RETRY\_EXHAUSTED**: `"RETRY_EXHAUSTED"`

Defined in: [shared/errors/error-code.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L12)

***

### S3\_OFFLOAD\_FAILED

> **S3\_OFFLOAD\_FAILED**: `"S3_OFFLOAD_FAILED"`

Defined in: [shared/errors/error-code.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L21)

***

### UPSTREAM

> **UPSTREAM**: `"UPSTREAM"`

Defined in: [shared/errors/error-code.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L25)

***

### VALIDATION

> **VALIDATION**: `"VALIDATION"`

Defined in: [shared/errors/error-code.ts:3](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L3)
