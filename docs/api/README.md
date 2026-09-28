**AWS LangGraph DynamoDB TypeScript**

***

# AWS LangGraph DynamoDB TypeScript

AWS DynamoDB implementation of LangGraph's checkpoint saver, memory store
and chat message history, in TypeScript.

Hides where anything lives.

This module re-exports and declares nothing of its own, so which module
holds an adapter, the factory, the error class, the serializer or a
collaborator type is free to change without moving anything a caller
imports. What appears here is the whole supported surface; the package's
exports map admits no deep import, so nothing else is reachable.

## Enumerations

- [ErrorCode](enumerations/ErrorCode.md)

## Classes

- [DynamoDBChatMessageHistory](classes/DynamoDBChatMessageHistory.md)
- [DynamoDBFactory](classes/DynamoDBFactory.md)
- [DynamoDBLangGraphError](classes/DynamoDBLangGraphError.md)
- [DynamoDBSaver](classes/DynamoDBSaver.md)
- [DynamoDBSessionChatMessageHistory](classes/DynamoDBSessionChatMessageHistory.md)
- [DynamoDBStore](classes/DynamoDBStore.md)

## Interfaces

- [BackfillOptions](interfaces/BackfillOptions.md)
- [BackfillResult](interfaces/BackfillResult.md)
- [BaseAdapterOptions](interfaces/BaseAdapterOptions.md)
- [BatchDrainDetails](interfaces/BatchDrainDetails.md)
- [BatchPassDetails](interfaces/BatchPassDetails.md)
- [CancelOptions](interfaces/CancelOptions.md)
- [CodecOptions](interfaces/CodecOptions.md)
- [CompensationFailedDetails](interfaces/CompensationFailedDetails.md)
- [CompressionConfig](interfaces/CompressionConfig.md)
- [CreateAllOptions](interfaces/CreateAllOptions.md)
- [CreatedAdapters](interfaces/CreatedAdapters.md)
- [DeltaChannelHistoryOptions](interfaces/DeltaChannelHistoryOptions.md)
- [ErrorContext](interfaces/ErrorContext.md)
- [ErrorDetailsByCode](interfaces/ErrorDetailsByCode.md)
- [FactoryBaseOptions](interfaces/FactoryBaseOptions.md)
- [ListNamespacesOptions](interfaces/ListNamespacesOptions.md)
- [ListSessionsOptions](interfaces/ListSessionsOptions.md)
- [Logger](interfaces/Logger.md)
- [MessageWindow](interfaces/MessageWindow.md)
- [MultiSessionHistory](interfaces/MultiSessionHistory.md)
- [RedactLoggerOptions](interfaces/RedactLoggerOptions.md)
- [RetryAttemptInfo](interfaces/RetryAttemptInfo.md)
- [RetryOptions](interfaces/RetryOptions.md)
- [RetryPolicy](interfaces/RetryPolicy.md)
- [S3ClientLike](interfaces/S3ClientLike.md)
- [S3ClientOptions](interfaces/S3ClientOptions.md)
- [S3CommandLike](interfaces/S3CommandLike.md)
- [S3OffloadConfig](interfaces/S3OffloadConfig.md)
- [SessionMetadata](interfaces/SessionMetadata.md)
- [SessionPage](interfaces/SessionPage.md)
- [VectorBackend](interfaces/VectorBackend.md)
- [VectorMatch](interfaces/VectorMatch.md)
- [VectorReconcileResult](interfaces/VectorReconcileResult.md)
- [VectorRef](interfaces/VectorRef.md)

## Type Aliases

- [AdapterSection](type-aliases/AdapterSection.md)
- [AdapterWindow](type-aliases/AdapterWindow.md)
- [AnyDynamoDBLangGraphError](type-aliases/AnyDynamoDBLangGraphError.md)
- [BatchWriteIncompleteDetails](type-aliases/BatchWriteIncompleteDetails.md)
- [CorruptMessagePolicy](type-aliases/CorruptMessagePolicy.md)
- [DynamoDBChatMessageHistoryOptions](type-aliases/DynamoDBChatMessageHistoryOptions.md)
- [DynamoDBDocumentLike](type-aliases/DynamoDBDocumentLike.md)
- [DynamoDBSaverOptions](type-aliases/DynamoDBSaverOptions.md)
- [DynamoDBStoreOptions](type-aliases/DynamoDBStoreOptions.md)
- [ErrorDetailsFor](type-aliases/ErrorDetailsFor.md)
- [GetMessagesOptions](type-aliases/GetMessagesOptions.md)
- [LogArgument](type-aliases/LogArgument.md)
- [Redactable](type-aliases/Redactable.md)
- [S3ClientConfigLike](type-aliases/S3ClientConfigLike.md)
- [S3ClientOption](type-aliases/S3ClientOption.md)
- [S3RegionLike](type-aliases/S3RegionLike.md)
- [SearchOptions](type-aliases/SearchOptions.md)
- [TtlOption](type-aliases/TtlOption.md)
- [VectorScoreDirection](type-aliases/VectorScoreDirection.md)

## Variables

- [JSON\_SERDE](variables/JSON_SERDE.md)

## Functions

- [backfillRecencyIndex](functions/backfillRecencyIndex.md)
- [isDynamoDBLangGraphError](functions/isDynamoDBLangGraphError.md)
- [redactLogger](functions/redactLogger.md)
- [redactSecrets](functions/redactSecrets.md)
