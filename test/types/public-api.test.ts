import { expectTypeOf } from 'expect-type';

import {
  type BatchWriteIncompleteDetails,
  type CompensationFailedDetails,
  ErrorCode,
  isDynamoDBLangGraphError,
} from '../../src/index';
import type {
  AdapterWindow,
  CancelOptions,
  CreateAllOptions,
  CreatedAdapters,
  DynamoDBChatMessageHistoryOptions,
  DynamoDBSaverOptions,
  DynamoDBStoreOptions,
  FactoryBaseOptions,
  GetMessagesOptions,
  ListSessionsOptions,
  MessageWindow,
  Redactable,
  RedactLoggerOptions,
  SessionBackend,
  TtlOption,
  VectorBackend,
  VectorMatch,
  VectorRef,
  VectorScoreDirection,
} from '../../src/index';
import type { DynamoDBChatMessageHistory, DynamoDBSaver, DynamoDBStore } from '../../src/index';

describe('public API types', () => {
  it('models the ttl option as days | seconds', () => {
    expectTypeOf<TtlOption>().toEqualTypeOf<{ days: number } | { seconds: number }>();
  });

  it('requires a string tableName on every adapter options type', () => {
    expectTypeOf<DynamoDBSaverOptions['tableName']>().toEqualTypeOf<string>();
    expectTypeOf<DynamoDBStoreOptions['tableName']>().toEqualTypeOf<string>();
    expectTypeOf<DynamoDBChatMessageHistoryOptions['tableName']>().toEqualTypeOf<string>();
  });

  it('exposes an optional vector backend on the store options', () => {
    expectTypeOf<DynamoDBStoreOptions['vectorBackend']>().toEqualTypeOf<
      VectorBackend | undefined
    >();
    expectTypeOf<DynamoDBStoreOptions['maxSearchCandidates']>().toEqualTypeOf<number | undefined>();
  });

  it('exposes an optional listKeys returning VectorRef[]', () => {
    expectTypeOf<VectorBackend['listKeys']>().toEqualTypeOf<
      ((namespacePrefix: string[]) => Promise<VectorRef[]>) | undefined
    >();
    expectTypeOf<VectorRef>().toEqualTypeOf<{ namespace: string[]; key: string }>();
  });

  it('describes the vector backend contract', () => {
    expectTypeOf<VectorBackend['upsert']>().parameters.toEqualTypeOf<
      [string[], string, number[]]
    >();
    expectTypeOf<VectorBackend['query']>().returns.resolves.toEqualTypeOf<VectorMatch[]>();
    expectTypeOf<VectorMatch>().toEqualTypeOf<{
      namespace: string[];
      key: string;
      score: number;
    }>();
  });

  it('CreateAllOptions.saver excludes clientConfig/createClient, not just client', () => {
    expectTypeOf<CreateAllOptions['saver']>().not.toHaveProperty('clientConfig');
    expectTypeOf<CreateAllOptions['saver']>().not.toHaveProperty('createClient');
    expectTypeOf<CreateAllOptions['store']>().not.toHaveProperty('clientConfig');
    expectTypeOf<CreateAllOptions['history']>().not.toHaveProperty('clientConfig');
  });
});

describe('types behind public signatures are exported (CORE-11)', () => {
  it('names the history option bags and the adapter backend', () => {
    expectTypeOf<GetMessagesOptions>().toEqualTypeOf<MessageWindow & CancelOptions>();
    expectTypeOf<ListSessionsOptions['maxItems']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ListSessionsOptions['maxIterations']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ListSessionsOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<SessionBackend['getMessages']>().parameters.toEqualTypeOf<
      [string, AdapterWindow?]
    >();
  });

  it('names the store score direction and the redaction inputs', () => {
    expectTypeOf<VectorScoreDirection>().toEqualTypeOf<'relevance' | 'distance'>();
    expectTypeOf<DynamoDBStoreOptions['vectorScoreDirection']>().toEqualTypeOf<
      VectorScoreDirection | undefined
    >();
    expectTypeOf<RedactLoggerOptions>().toHaveProperty('extraKeys');
    expectTypeOf<RedactLoggerOptions>().toHaveProperty('extraValuePatterns');
    expectTypeOf<Redactable>().not.toBeNever();
  });
});

describe('factory shared defaults and partial createAll (CORE-17)', () => {
  it('carries shared ttl, compression, s3 and retry on the factory base options', () => {
    expectTypeOf<FactoryBaseOptions['ttl']>().toEqualTypeOf<TtlOption | undefined>();
    expectTypeOf<FactoryBaseOptions>().toHaveProperty('compression');
    expectTypeOf<FactoryBaseOptions>().toHaveProperty('s3');
    expectTypeOf<FactoryBaseOptions>().toHaveProperty('retry');
  });

  it('types the created adapters by the sections given', () => {
    type StoreOnly = CreatedAdapters<{ store: { tableName: string } }>;
    expectTypeOf<StoreOnly['store']>().toEqualTypeOf<DynamoDBStore>();
    expectTypeOf<StoreOnly['saver']>().toEqualTypeOf<undefined>();
    expectTypeOf<StoreOnly['history']>().toEqualTypeOf<undefined>();
    expectTypeOf<CreatedAdapters['saver']>().toEqualTypeOf<DynamoDBSaver>();
    expectTypeOf<CreatedAdapters['history']>().toEqualTypeOf<DynamoDBChatMessageHistory>();
    expectTypeOf<NonNullable<CreateAllOptions['saver']>>().not.toHaveProperty('clientConfig');
    expectTypeOf<CreateAllOptions['saver']>().toEqualTypeOf<
      Omit<DynamoDBSaverOptions, 'client' | 'clientConfig' | 'createClient'> | undefined
    >();
  });
});

describe('a code narrows the details it carries', () => {
  it('types details by code, and as undefined for a code without any', () => {
    const caught = new Error('x');
    if (isDynamoDBLangGraphError(caught)) {
      if (caught.code === ErrorCode.COMPENSATION_FAILED) {
        expectTypeOf(caught.details).toEqualTypeOf<CompensationFailedDetails>();
      }
      if (caught.code === ErrorCode.BATCH_WRITE_INCOMPLETE) {
        expectTypeOf(caught.details).toEqualTypeOf<BatchWriteIncompleteDetails>();
      }
      if (caught.code === ErrorCode.VALIDATION) {
        expectTypeOf(caught.details).toEqualTypeOf<undefined>();
      }
    }
    expect(isDynamoDBLangGraphError(caught)).toBe(false);
  });
});
