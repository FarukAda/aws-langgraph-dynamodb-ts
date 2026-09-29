[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ErrorCode

# Enumeration: ErrorCode

Defined in: [shared/errors/error-code.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L12)

Stable, branchable classification for every error this library throws.

## Enumeration Members

### ABORTED

> **ABORTED**: `"ABORTED"`

Defined in: [shared/errors/error-code.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L33)

***

### ACCESS\_DENIED

> **ACCESS\_DENIED**: `"ACCESS_DENIED"`

Defined in: [shared/errors/error-code.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L67)

AWS refused the caller's identity or permissions: `AccessDeniedException`,
S3's `AccessDenied`, an expired, unrecognised or malformed credential or
signature. Fix the credentials or the IAM policy; do not retry.
`context.awsErrorName` says which.

***

### ANCESTOR\_EXPIRED

> **ANCESTOR\_EXPIRED**: `"ANCESTOR_EXPIRED"`

Defined in: [shared/errors/error-code.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L20)

A checkpoint a delta channel still needs has expired, so the channel cannot
be reconstructed and the read refuses rather than returning a shorter value.

***

### AWS\_REJECTED

> **AWS\_REJECTED**: `"AWS_REJECTED"`

Defined in: [shared/errors/error-code.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L82)

AWS rejected the request as malformed: `ValidationException`,
AWS's `ValidationError` common error, `IdempotentParameterMismatchException`,
or a request body it could not read or accept. Retrying the same request
fails the same way.

***

### AWS\_REQUEST\_FAILED

> **AWS\_REQUEST\_FAILED**: `"AWS_REQUEST_FAILED"`

Defined in: [shared/errors/error-code.ts:84](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L84)

An AWS request failed and no narrower code applies; `context.awsErrorName` names it.

***

### BATCH\_WRITE\_INCOMPLETE

> **BATCH\_WRITE\_INCOMPLETE**: `"BATCH_WRITE_INCOMPLETE"`

Defined in: [shared/errors/error-code.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L23)

***

### COMPENSATION\_FAILED

> **COMPENSATION\_FAILED**: `"COMPENSATION_FAILED"`

Defined in: [shared/errors/error-code.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L34)

***

### COMPRESSION\_LIMIT

> **COMPRESSION\_LIMIT**: `"COMPRESSION_LIMIT"`

Defined in: [shared/errors/error-code.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L24)

***

### CONDITION\_CONFLICT

> **CONDITION\_CONFLICT**: `"CONDITION_CONFLICT"`

Defined in: [shared/errors/error-code.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L21)

***

### CONTENTION

> **CONTENTION**: `"CONTENTION"`

Defined in: [shared/errors/error-code.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L60)

Another request was writing the same item or object at the same moment:
`TransactionConflictException`, `TransactionInProgressException`,
`ReplicatedWriteConflictException`, S3's `ConditionalRequestConflict`, or a
cancelled transaction whose only transient cause is a conflict. Retry; more
capacity would not help. `ensureS3LifecycleRule()` raises it when every one
of its five rounds needs a write.

***

### FORMAT\_UNSUPPORTED

> **FORMAT\_UNSUPPORTED**: `"FORMAT_UNSUPPORTED"`

Defined in: [shared/errors/error-code.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L15)

A row or payload written in a format version newer than this package reads.

***

### NOT\_FOUND

> **NOT\_FOUND**: `"NOT_FOUND"`

Defined in: [shared/errors/error-code.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L75)

The table or the bucket is not there: `ResourceNotFoundException`, or S3's
`NoSuchBucket` from the lifecycle calls. A missing index is `AWS_REJECTED`
— DynamoDB refuses a query naming one with a `ValidationException` — and a
missing S3 object on a transfer is `S3_OFFLOAD_FAILED`. Not an absent item:
a read of a key that holds nothing returns nothing.

***

### PAYLOAD\_CORRUPT

> **PAYLOAD\_CORRUPT**: `"PAYLOAD_CORRUPT"`

Defined in: [shared/errors/error-code.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L30)

A stored payload's bytes do not match the form its row declares: the row
says gzip and they are not, or they are not the serializer's output. The
payload can never be read, so it is reported rather than retried.

***

### RESULT\_TRUNCATED

> **RESULT\_TRUNCATED**: `"RESULT_TRUNCATED"`

Defined in: [shared/errors/error-code.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L32)

***

### RETRY\_EXHAUSTED

> **RETRY\_EXHAUSTED**: `"RETRY_EXHAUSTED"`

Defined in: [shared/errors/error-code.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L22)

***

### S3\_OFFLOAD\_FAILED

> **S3\_OFFLOAD\_FAILED**: `"S3_OFFLOAD_FAILED"`

Defined in: [shared/errors/error-code.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L31)

***

### SERVICE\_UNAVAILABLE

> **SERVICE\_UNAVAILABLE**: `"SERVICE_UNAVAILABLE"`

Defined in: [shared/errors/error-code.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L51)

AWS or the network failed transiently: `InternalServerError`,
`InternalFailure`, `ServiceUnavailable`, S3's `InternalError`, a request
timeout (`RequestTimeout`, `RequestTimeoutException`, the SDK's
`TimeoutError`), an HTTP 500/502/503/504, or a reset, refused or
unreachable connection. Retry after a backoff. A write that failed this way
may still have been applied.

***

### THROTTLED

> **THROTTLED**: `"THROTTLED"`

Defined in: [shared/errors/error-code.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L42)

AWS throttled the request: `ProvisionedThroughputExceededException`,
`ThrottlingException`, `RequestLimitExceeded`, S3's `SlowDown`, an HTTP
429, or a cancelled transaction whose causes are all transient and include
a throttling reason. Back off, or raise the table's capacity or the account
quota.

***

### UNEXPECTED\_ERROR

> **UNEXPECTED\_ERROR**: `"UNEXPECTED_ERROR"`

Defined in: [shared/errors/error-code.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L91)

A failure that came neither from this package's own checks nor from AWS:
a `VectorBackend`, an `Embeddings` model, a `serde` or a `MultiSessionHistory`
threw something of its own, or this package has a bug. The original is
`cause`.

***

### VALIDATION

> **VALIDATION**: `"VALIDATION"`

Defined in: [shared/errors/error-code.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/error-code.ts#L13)
