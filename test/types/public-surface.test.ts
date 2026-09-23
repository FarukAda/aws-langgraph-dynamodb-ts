import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  BaseCheckpointSaver,
  BaseStore,
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
  SearchOperation,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { expectTypeOf } from 'expect-type';

import * as api from '../../src/index';
import type {
  AdapterSection,
  AdapterWindow,
  BackfillOptions,
  BaseAdapterOptions,
  CancelOptions,
  CodecOptions,
  CompressionConfig,
  CorruptMessagePolicy,
  CreateAllOptions,
  CreatedAdapters,
  DeltaChannelHistoryOptions,
  DynamoDBChatMessageHistory,
  DynamoDBChatMessageHistoryOptions,
  DynamoDBDocumentLike,
  DynamoDBFactory,
  DynamoDBSaver,
  DynamoDBSaverOptions,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
  DynamoDBStoreOptions,
  ErrorContext,
  FactoryBaseOptions,
  GetMessagesOptions,
  ListNamespacesOptions,
  ListSessionsOptions,
  LogArgument,
  Logger,
  MessageWindow,
  Redactable,
  RedactLoggerOptions,
  RetryAttemptInfo,
  RetryOptions,
  RetryPolicy,
  S3ClientConfigLike,
  S3ClientLike,
  S3ClientOption,
  S3ClientOptions,
  S3CommandLike,
  S3OffloadConfig,
  S3RegionLike,
  SearchOptions,
  SessionBackend,
  SessionMetadata,
  SessionPage,
  TtlOption,
  VectorBackend,
  VectorMatch,
  VectorReconcileResult,
  VectorRef,
  VectorScoreDirection,
} from '../../src/index';
import { createStrictDocumentMock } from '../shared/helpers/ddb-mock';

/**
 * Every runtime export, deliberately spelled out: adding or removing one is a
 * semver decision, so it has to be made here as well as in `src/index.ts`.
 */
const VALUE_EXPORTS = [
  'DynamoDBChatMessageHistory',
  'DynamoDBFactory',
  'DynamoDBLangGraphError',
  'DynamoDBSaver',
  'DynamoDBSessionChatMessageHistory',
  'DynamoDBStore',
  'ErrorCode',
  /** The plain-JSON `serde`: the store/history default, and a checkpointer's alternative. */
  'JSON_SERDE',
  /** Operator tool: see `backfillRecencyIndex`; run before enabling `indexName`. */
  'backfillRecencyIndex',
  'isDynamoDBLangGraphError',
  'redactLogger',
  'redactSecrets',
] as const;

describe('public value exports (CORE-12, TEST-10)', () => {
  it('are exactly the documented set, at runtime and in the types', () => {
    expect(Object.keys(api).sort()).toEqual([...VALUE_EXPORTS].sort());
    expectTypeOf<keyof typeof api>().toEqualTypeOf<(typeof VALUE_EXPORTS)[number]>();
  });

  /**
   * `JSON_SERDE` is offered as something to pass as `serde`, so what it is
   * typed as is the whole of its usefulness: anything narrower than the
   * protocol would compile here and fail at the option it exists to fill.
   */
  it('offer the plain-JSON serde as a SerializerProtocol, frozen', () => {
    expectTypeOf<typeof api.JSON_SERDE>().toEqualTypeOf<SerializerProtocol>();
    expect(Object.isFrozen(api.JSON_SERDE)).toBe(true);
  });
});

describe('public type exports (CORE-12, TEST-10)', () => {
  it('each resolve to a real type (the import list above is the lock)', () => {
    expectTypeOf<AdapterSection<DynamoDBSaverOptions>>().not.toHaveProperty('client');
    expectTypeOf<AdapterWindow>().toEqualTypeOf<{ limit?: number }>();
    /**
     * `RetryOptions` is exported and pinned above, but nothing previously
     * pinned what `BackfillOptions['retry']` resolves to, which is how a
     * silent narrowing to the adapters' `RetryPolicy` passed unnoticed: it
     * compiled, since `RetryPolicy` is structurally assignable wherever a
     * plain `{ maxAttempts }` literal is used, and only broke a caller who
     * passed `onRetry` — backfill's only way to observe retries, since it
     * takes no `logger`.
     */
    expectTypeOf<BackfillOptions['retry']>().toEqualTypeOf<RetryOptions | undefined>();
    expectTypeOf<BaseAdapterOptions['tableName']>().toEqualTypeOf<string>();
    expectTypeOf<CancelOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<CodecOptions>().toHaveProperty('compression');
    expectTypeOf<CodecOptions>().toHaveProperty('s3');
    expectTypeOf<CompressionConfig['enabled']>().toEqualTypeOf<boolean>();
    expectTypeOf<CorruptMessagePolicy>().toEqualTypeOf<'skip' | 'throw'>();
    expectTypeOf<CreateAllOptions>().toHaveProperty('saver');
    expectTypeOf<CreatedAdapters['destroy']>().toEqualTypeOf<() => void>();
    /**
     * Named for the reference and for callers, not redefined: each must stay
     * exactly the parameter type upstream's method declares inline.
     */
    expectTypeOf<DeltaChannelHistoryOptions>().toEqualTypeOf<
      Parameters<BaseCheckpointSaver['getDeltaChannelHistory']>[0]
    >();
    /**
     * Named rather than aliased to the SDK's own class: an option typed by
     * identity is unusable for a consumer whose SDK copy is not this one.
     */
    expectTypeOf<DynamoDBDocumentLike>().toHaveProperty('transactWrite');
    expectTypeOf<ErrorContext>().toHaveProperty('operation');
    expectTypeOf<FactoryBaseOptions>().toHaveProperty('logger');
    expectTypeOf<GetMessagesOptions>().toEqualTypeOf<MessageWindow & CancelOptions>();
    expectTypeOf<ListNamespacesOptions>().toEqualTypeOf<
      NonNullable<Parameters<BaseStore['listNamespaces']>[0]>
    >();
    expectTypeOf<ListSessionsOptions>().toHaveProperty('maxItems');
    expectTypeOf<Logger['warn']>().parameters.toEqualTypeOf<[string, ...LogArgument[]]>();
    expectTypeOf<Redactable>().not.toBeNever();
    expectTypeOf<RedactLoggerOptions>().toHaveProperty('extraKeys');
    expectTypeOf<RetryAttemptInfo>().toHaveProperty('attempt');
    expectTypeOf<RetryOptions>().toHaveProperty('maxAttempts');
    expectTypeOf<RetryPolicy>().toHaveProperty('maxAttempts');
    expectTypeOf<S3OffloadConfig['clientConfig']>().toEqualTypeOf<S3ClientConfigLike | undefined>();
    expectTypeOf<S3ClientLike>().toHaveProperty('destroy');
    expectTypeOf<S3CommandLike>().toHaveProperty('input');
    expectTypeOf<S3ClientOptions['region']>().toEqualTypeOf<S3RegionLike | undefined>();
    expectTypeOf<S3ClientOption>().not.toBeNever();
    expectTypeOf<SearchOptions>().toEqualTypeOf<
      Pick<SearchOperation, 'filter' | 'limit' | 'offset' | 'query'> & CancelOptions
    >();
    expectTypeOf<SessionBackend>().toHaveProperty('getMessages');
    expectTypeOf<SessionMetadata['expiresAt']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TtlOption>().toEqualTypeOf<{ days: number } | { seconds: number }>();
    expectTypeOf<VectorBackend>().toHaveProperty('query');
    expectTypeOf<VectorMatch>().toEqualTypeOf<{
      namespace: string[];
      key: string;
      score: number;
    }>();
    expectTypeOf<VectorReconcileResult>().toEqualTypeOf<{ upserted: number; pruned: number }>();
    expectTypeOf<VectorRef>().toEqualTypeOf<{ namespace: string[]; key: string }>();
    expectTypeOf<VectorScoreDirection>().toEqualTypeOf<'relevance' | 'distance'>();
  });
});

describe('adapter signatures (TEST-10)', () => {
  it('the checkpointer implements BaseCheckpointSaver and takes a cancellable deleteThread', () => {
    expectTypeOf<DynamoDBSaver>().toMatchTypeOf<BaseCheckpointSaver>();
    expectTypeOf<DynamoDBSaver['deleteThread']>().parameters.toEqualTypeOf<
      [string, CancelOptions?]
    >();
    expectTypeOf<DynamoDBSaver['put']>().parameters.toEqualTypeOf<
      [RunnableConfig, Checkpoint, CheckpointMetadata, ChannelVersions?]
    >();
    expectTypeOf<DynamoDBSaver['getDeltaChannelHistory']>().toEqualTypeOf<
      BaseCheckpointSaver['getDeltaChannelHistory']
    >();
    expectTypeOf<DynamoDBSaver['getDeltaChannelHistory']>().parameters.toEqualTypeOf<
      [DeltaChannelHistoryOptions]
    >();
    expectTypeOf<DynamoDBSaver['ensureS3LifecycleRule']>().returns.resolves.toBeVoid();
    expectTypeOf<DynamoDBSaver['destroy']>().returns.toBeVoid();
  });

  it('the store implements BaseStore with cancellable search and reconcile, stop and destroy', () => {
    expectTypeOf<DynamoDBStore>().toMatchTypeOf<BaseStore>();
    expectTypeOf<DynamoDBStore['get']>().toEqualTypeOf<BaseStore['get']>();
    expectTypeOf<DynamoDBStore['put']>().toEqualTypeOf<BaseStore['put']>();
    expectTypeOf<DynamoDBStore['delete']>().toEqualTypeOf<BaseStore['delete']>();
    expectTypeOf<DynamoDBStore['listNamespaces']>().toEqualTypeOf<BaseStore['listNamespaces']>();
    expectTypeOf<DynamoDBStore['listNamespaces']>().parameters.toEqualTypeOf<
      [ListNamespacesOptions?]
    >();
    expectTypeOf<DynamoDBStore['search']>().parameters.toEqualTypeOf<
      [string[], (Pick<SearchOperation, 'filter' | 'limit' | 'offset' | 'query'> & CancelOptions)?]
    >();
    expectTypeOf<DynamoDBStore['reconcileVectorIndex']>().parameters.toEqualTypeOf<
      [string[], CancelOptions?]
    >();
    expectTypeOf<
      DynamoDBStore['reconcileVectorIndex']
    >().returns.resolves.toEqualTypeOf<VectorReconcileResult>();
    expectTypeOf<DynamoDBStore['stop']>().returns.toBeVoid();
    expectTypeOf<DynamoDBStore['destroy']>().returns.toBeVoid();
    expectTypeOf<DynamoDBStore['ensureS3LifecycleRule']>().returns.resolves.toBeVoid();
  });

  it('the chat history exposes windowed reads, a bound adapter and cancellable maintenance', () => {
    expectTypeOf<DynamoDBChatMessageHistory['getMessages']>().parameters.toEqualTypeOf<
      [string, GetMessagesOptions?]
    >();
    expectTypeOf<DynamoDBChatMessageHistory['getMessages']>().returns.resolves.toEqualTypeOf<
      BaseMessage[]
    >();
    expectTypeOf<DynamoDBChatMessageHistory['forSession']>().parameters.toEqualTypeOf<
      [string, AdapterWindow?]
    >();
    expectTypeOf<
      DynamoDBChatMessageHistory['forSession']
    >().returns.toEqualTypeOf<DynamoDBSessionChatMessageHistory>();
    expectTypeOf<DynamoDBChatMessageHistory['listSessions']>().parameters.toEqualTypeOf<
      [ListSessionsOptions?]
    >();
    expectTypeOf<
      DynamoDBChatMessageHistory['listSessions']
    >().returns.resolves.toEqualTypeOf<SessionPage>();
    expectTypeOf<DynamoDBChatMessageHistory['addMessage']>().parameters.toEqualTypeOf<
      [string, BaseMessage, CancelOptions?]
    >();
    expectTypeOf<DynamoDBChatMessageHistory['addMessages']>().parameters.toEqualTypeOf<
      [string, BaseMessage[], CancelOptions?]
    >();
    expectTypeOf<DynamoDBChatMessageHistory['clear']>().parameters.toEqualTypeOf<
      [string, CancelOptions?]
    >();
    expectTypeOf<DynamoDBChatMessageHistory['reconcileMessageCount']>().parameters.toEqualTypeOf<
      [string, CancelOptions?]
    >();
    expectTypeOf<
      DynamoDBChatMessageHistory['reconcileMessageCount']
    >().returns.resolves.toBeNumber();
  });

  it('the factory builds each adapter and any subset of all three', () => {
    expectTypeOf<DynamoDBFactory['createSaver']>().returns.toEqualTypeOf<DynamoDBSaver>();
    expectTypeOf<DynamoDBFactory['createStore']>().returns.toEqualTypeOf<DynamoDBStore>();
    expectTypeOf<
      DynamoDBFactory['createChatMessageHistory']
    >().returns.toEqualTypeOf<DynamoDBChatMessageHistory>();
    expectTypeOf<DynamoDBFactory['createAll']>().parameter(0).toMatchTypeOf<CreateAllOptions>();
  });

  it('every options type is assignable from a plain literal, with clientConfig or with client', () => {
    const { client } = createStrictDocumentMock();
    const saver: DynamoDBSaverOptions = { tableName: 't', clientConfig: { region: 'eu-west-1' } };
    const store: DynamoDBStoreOptions = { tableName: 't', client, maxSearchCandidates: 10 };
    const history: DynamoDBChatMessageHistoryOptions = {
      tableName: 't',
      client,
      ttl: { days: 1 },
      compression: { enabled: true },
      s3: { bucketName: 'b' },
      retry: { maxAttempts: 2 },
      onCorruptMessage: 'throw',
    };
    expect([saver, store, history]).toHaveLength(3);
  });
});
