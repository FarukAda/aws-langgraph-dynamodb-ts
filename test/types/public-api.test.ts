import { expectTypeOf } from 'expect-type';

import type {
  CreateAllOptions,
  DynamoDBChatMessageHistoryOptions,
  DynamoDBSaverOptions,
  DynamoDBStoreOptions,
  TtlOption,
  VectorBackend,
  VectorMatch,
  VectorRef,
} from '../../src/index';

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
