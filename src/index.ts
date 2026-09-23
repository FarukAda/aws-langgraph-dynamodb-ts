export { DynamoDBSaver } from './checkpointer/saver';
export type { DeltaChannelHistoryOptions, DynamoDBSaverOptions } from './checkpointer/types';
export { DynamoDBStore } from './store/store';
export type { DynamoDBStoreOptions, ListNamespacesOptions, SearchOptions } from './store/types';
export type { VectorReconcileResult } from './store/actions/reconcile-vector-index';
export type {
  VectorBackend,
  VectorMatch,
  VectorRef,
  VectorScoreDirection,
} from './store/vector-backend';
export { DynamoDBChatMessageHistory } from './history/chat-message-history';
export { DynamoDBSessionChatMessageHistory } from './history/session-adapter';
export type { AdapterWindow, SessionBackend } from './history/session-adapter';
export type {
  CorruptMessagePolicy,
  DynamoDBChatMessageHistoryOptions,
  GetMessagesOptions,
  ListSessionsOptions,
  SessionPage,
  MessageWindow,
  SessionMetadata,
} from './history/types';
/**
 * Operator tool: give rows written before the recency index their index keys.
 * Run it before setting `indexName` on any adapter — see its own documentation
 * for why enabling the index first hides pre-existing rows from the listings.
 */
export { backfillRecencyIndex } from './shared/dynamodb/backfill-index';
export type { BackfillOptions, BackfillResult } from './shared/dynamodb/backfill-types';

export { DynamoDBFactory } from './factory/factory';
export type {
  AdapterSection,
  CreateAllOptions,
  CreatedAdapters,
  FactoryBaseOptions,
} from './factory/types';

/**
 * The plain JSON serializer the store and chat-history adapters use by
 * default, exported so a checkpointer can be given it in place of LangGraph's
 * `JsonPlusSerializer`, whose read path instantiates the class a stored
 * `{"lc": …}` record names. See the README's *Trust boundary* note and
 * `SECURITY.md`.
 */
export { JSON_SERDE } from './shared/codec/json-serde';

export { DynamoDBLangGraphError, isDynamoDBLangGraphError } from './shared/errors/base-error';
export type {
  AnyDynamoDBLangGraphError,
  BatchDrainDetails,
  BatchPassDetails,
  BatchWriteIncompleteDetails,
  CompensationFailedDetails,
  ErrorContext,
  ErrorDetailsByCode,
  ErrorDetailsFor,
} from './shared/errors/base-error';
export { ErrorCode } from './shared/errors/error-code';

export type { Logger, LogArgument } from './shared/logging/logger';
export { redactLogger, redactSecrets } from './shared/logging/redaction';
export type { RedactLoggerOptions } from './shared/logging/redaction';
export type { Redactable } from './shared/logging/redaction-walk';

export type { CancelOptions, BaseAdapterOptions, CodecOptions } from './shared/options';
export type { DynamoDBDocumentLike } from './shared/dynamodb/client';
export type { RetryAttemptInfo, RetryOptions } from './shared/dynamodb/retry';
export type { RetryPolicy } from './shared/dynamodb/retry-policy';
export type { TtlOption } from './shared/validation/ttl';
export type { CompressionConfig } from './shared/codec/compression';
export type { S3OffloadConfig } from './shared/codec/s3/config';
export type {
  S3ClientConfigLike,
  S3ClientLike,
  S3ClientOption,
  S3ClientOptions,
  S3CommandLike,
  S3RegionLike,
} from './shared/codec/s3/client-types';
