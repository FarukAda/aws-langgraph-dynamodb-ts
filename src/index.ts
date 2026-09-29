/**
 * AWS DynamoDB implementation of LangGraph's checkpoint saver, memory store
 * and chat message history, in TypeScript.
 *
 * Hides where anything lives.
 *
 * This module re-exports and declares nothing of its own, so which module
 * holds an adapter, the factory, the error class, the serializer or a
 * collaborator type is free to change without moving anything a caller
 * imports. What appears here is the whole supported surface; the package's
 * exports map admits no deep import, so nothing else is reachable.
 *
 * @packageDocumentation
 */

export { DynamoDBSaver } from './checkpointer/saver.js';
export type { DeltaChannelHistoryOptions, DynamoDBSaverOptions } from './checkpointer/types.js';
export { DynamoDBStore } from './store/store.js';
export type {
  DynamoDBStoreOptions,
  ListNamespacesOptions,
  SearchOptions,
  VectorReconcileResult,
} from './store/types.js';
export type {
  VectorBackend,
  VectorMatch,
  VectorRef,
  VectorScoreDirection,
} from './store/vector-backend.js';
export { DynamoDBChatMessageHistory } from './history/chat-message-history.js';
export { DynamoDBSessionChatMessageHistory } from './history/session-adapter.js';
export type { AdapterWindow, MultiSessionHistory } from './history/session-adapter.js';
export type {
  CorruptMessagePolicy,
  DynamoDBChatMessageHistoryOptions,
  GetMessagesOptions,
  ListSessionsOptions,
  SessionPage,
  MessageWindow,
  SessionMetadata,
} from './history/types.js';
/**
 * Operator tool: give rows written before the recency index their index keys.
 * Run it before setting `indexName` on any adapter — see its own documentation
 * for why enabling the index first hides pre-existing rows from the listings.
 */
export { backfillRecencyIndex } from './backfill/backfill.js';
export type { BackfillOptions, BackfillResult } from './backfill/backfill.js';

export { DynamoDBFactory } from './factory/factory.js';
export type {
  AdapterSection,
  CreateAllOptions,
  CreatedAdapters,
  FactoryBaseOptions,
} from './factory/types.js';

/**
 * The plain JSON serializer the store and chat-history adapters use by
 * default, exported so a checkpointer can be given it in place of LangGraph's
 * `JsonPlusSerializer`, whose read path instantiates the class a stored
 * `{"lc": …}` record names. See the README's *Trust boundary* note and
 * `SECURITY.md`.
 */
export { JSON_SERDE } from './shared/codec/json-serde.js';

export { DynamoDBLangGraphError, isDynamoDBLangGraphError } from './shared/errors/base-error.js';
export type {
  AnyDynamoDBLangGraphError,
  BatchDrainDetails,
  BatchPassDetails,
  BatchWriteIncompleteDetails,
  CompensationFailedDetails,
  ErrorContext,
  ErrorDetailsByCode,
  ErrorDetailsFor,
} from './shared/errors/base-error.js';
export { ErrorCode } from './shared/errors/error-code.js';

export type { Logger, LogArgument } from './shared/logging/logger.js';
export { redactLogger, redactSecrets } from './shared/logging/redaction.js';
export type { Redactable, RedactLoggerOptions } from './shared/logging/redaction.js';

export type { CancelOptions, BaseAdapterOptions, CodecOptions } from './shared/options.js';
export type { DynamoDBDocumentLike } from './shared/dynamodb/client.js';
export type { RetryAttemptInfo, RetryOptions, RetryPolicy } from './shared/dynamodb/retry.js';
export type { TtlOption } from './shared/validation/ttl.js';
export type { CompressionConfig } from './shared/codec/compression.js';
export type { S3OffloadConfig } from './shared/codec/s3/config.js';
export type {
  S3ClientConfigLike,
  S3ClientOption,
  S3ClientOptions,
  S3RegionLike,
} from './shared/codec/s3/client-types.js';
