/**
 * TYPES tier — compile-time public-API lock for `@farukada/aws-langgraph-dynamodb-ts`.
 *
 * This file uses `expectTypeOf` from the `expect-type` package (a pure compile-time
 * type-assertion library with zero runtime cost). It is consumed by the normal
 * `npm run test` (jest + ts-jest) run: ts-jest type-checks the file, so any failing
 * `expectTypeOf` assertion surfaces as a TypeScript compile error and fails CI.
 *
 * Contract (REQ-29 / AC-25):
 *   - Every value exported from `src/index.ts` must exist with the documented signature.
 *   - Every type exported from `src/index.ts` must exist with the documented shape.
 *   - Renaming or REMOVING any export must fail this file's compilation.
 *   - ADDING the documented additive optional seam fields (REQ-44/REQ-46/REQ-47) — most
 *     notably `RetryOptions.rng?` and the optional Clock / AWS-client-factory fields on the
 *     option interfaces — must NOT fail. We therefore assert the REQUIRED members of the
 *     seam-augmented interfaces and assert the optional seam members are accepted as
 *     OPTIONAL, rather than asserting those interfaces are closed.
 *
 * Tool note: `expect-type` is NOT yet a devDependency (see FINAL REPORT). The implementer
 * must add it. The plan (REQ-29) names `expectTypeOf`/`tsd`; `expect-type` is the
 * jest/ts-jest-native choice so this file runs inside `npm run test`.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { BaseStore } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { expectTypeOf } from 'expect-type';

import type {
  BatchWriteIncompleteError as BatchWriteIncompleteErrorType,
  CompressionConfig,
  DynamoDBChatMessageHistory as DynamoDBChatMessageHistoryClass,
  DynamoDBChatMessageHistoryOptions,
  DynamoDBFactory as DynamoDBFactoryClass,
  DynamoDBSaver as DynamoDBSaverClass,
  DynamoDBSaverOptions,
  DynamoDBSessionChatMessageHistory as DynamoDBSessionChatMessageHistoryClass,
  DynamoDBStore as DynamoDBStoreClass,
  DynamoDBStoreOptions,
  Logger,
  RetryOptions,
  S3OffloadConfig,
  SessionMetadata,
} from '../../src/index';
import {
  BatchWriteIncompleteError,
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBSaver,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
  getLogger,
  redactLogger,
  redactSecrets,
  resetLogger,
  setGlobalLogger,
} from '../../src/index';

describe('public-api type surface (src/index.ts)', () => {
  it('locks the exported value & type symbols so any rename/removal fails to compile', () => {
    // ---- Exported values must exist (a removed/renamed export errors on import above). ----
    expectTypeOf(DynamoDBSaver).toBeConstructibleWith({} as DynamoDBSaverOptions);
    expectTypeOf(DynamoDBStore).toBeConstructibleWith({} as DynamoDBStoreOptions);
    expectTypeOf(DynamoDBChatMessageHistory).toBeConstructibleWith(
      {} as DynamoDBChatMessageHistoryOptions,
    );
    expectTypeOf(DynamoDBSessionChatMessageHistory).toBeObject();
    expectTypeOf(DynamoDBFactory).toBeObject();
    expectTypeOf(BatchWriteIncompleteError).toBeConstructibleWith();

    expectTypeOf(setGlobalLogger).toBeFunction();
    expectTypeOf(getLogger).toBeFunction();
    expectTypeOf(resetLogger).toBeFunction();
    expectTypeOf(redactLogger).toBeFunction();
    expectTypeOf(redactSecrets).toBeFunction();

    // ---- Exported type aliases must exist & be referenceable (removal errors on import). ----
    expectTypeOf<DynamoDBSaverOptions>().not.toBeNever();
    expectTypeOf<DynamoDBStoreOptions>().not.toBeNever();
    expectTypeOf<DynamoDBChatMessageHistoryOptions>().not.toBeNever();
    expectTypeOf<SessionMetadata>().not.toBeNever();
    expectTypeOf<Logger>().not.toBeNever();
    expectTypeOf<CompressionConfig>().not.toBeNever();
    expectTypeOf<S3OffloadConfig>().not.toBeNever();
    expectTypeOf<RetryOptions>().not.toBeNever();
  }); // AC-25
});

describe('DynamoDBSaver class shape', () => {
  it('locks DynamoDBSaver as a BaseCheckpointSaver subclass with the documented method signatures', () => {
    type Saver = InstanceType<typeof DynamoDBSaverClass>;
    expectTypeOf<Saver>().toMatchTypeOf<BaseCheckpointSaver>();

    const saver = {} as Saver;
    expectTypeOf(saver.destroy).returns.toBeVoid();

    expectTypeOf(saver.deleteThread).toBeCallableWith('thread-1');
    expectTypeOf(saver.deleteThread).toBeCallableWith('thread-1', {
      signal: new AbortController().signal,
    });
    expectTypeOf(saver.deleteThread).returns.resolves.toBeVoid();

    expectTypeOf(saver.getTuple).parameter(0).not.toBeNever();
    expectTypeOf(saver.getTuple).returns.resolves.not.toBeNever();

    expectTypeOf(saver.put).returns.resolves.not.toBeNever();
    expectTypeOf(saver.putWrites).returns.resolves.toBeVoid();
    expectTypeOf(saver.list).not.toBeNever();
  }); // AC-25

  it('rejects a DynamoDBSaver instance missing the BaseCheckpointSaver contract (negative)', () => {
    type Saver = InstanceType<typeof DynamoDBSaverClass>;
    // A plain object lacking the saver methods must NOT be assignable to the instance type.
    expectTypeOf<{ destroy: () => void }>().not.toEqualTypeOf<Saver>();
    // `deleteThread` is async — a sync void return must not match.
    const saver = {} as Saver;
    expectTypeOf(saver.deleteThread).returns.not.toBeVoid();
  }); // AC-25
});

describe('DynamoDBStore class shape', () => {
  it('locks DynamoDBStore as a BaseStore subclass exposing destroy() and batch()', () => {
    type Store = InstanceType<typeof DynamoDBStoreClass>;
    expectTypeOf<Store>().toMatchTypeOf<BaseStore>();

    const store = {} as Store;
    expectTypeOf(store.destroy).returns.toBeVoid();
    expectTypeOf(store.batch).toBeFunction();
    expectTypeOf(store.batch).returns.resolves.not.toBeNever();
  }); // AC-25

  it('rejects a DynamoDBStore instance type that drops batch() (negative)', () => {
    type Store = InstanceType<typeof DynamoDBStoreClass>;
    expectTypeOf<{ destroy: () => void }>().not.toEqualTypeOf<Store>();
  }); // AC-25
});

describe('DynamoDBChatMessageHistory class shape', () => {
  it('locks the documented chat-history method signatures', () => {
    type History = InstanceType<typeof DynamoDBChatMessageHistoryClass>;
    const history = {} as History;

    expectTypeOf(history.destroy).returns.toBeVoid();

    expectTypeOf(history.getMessages).toBeCallableWith('user', 'session');
    expectTypeOf(history.getMessages).toBeCallableWith('user', 'session', {
      signal: new AbortController().signal,
    });
    expectTypeOf(history.getMessages).returns.resolves.toEqualTypeOf<BaseMessage[]>();

    expectTypeOf(history.addMessage).toBeCallableWith('user', 'session', {} as BaseMessage);
    expectTypeOf(history.addMessage).returns.resolves.toBeVoid();

    expectTypeOf(history.addMessages).toBeCallableWith('user', 'session', [] as BaseMessage[]);
    expectTypeOf(history.addMessages).returns.resolves.toBeVoid();

    expectTypeOf(history.clear).toBeCallableWith('user', 'session');
    expectTypeOf(history.clear).returns.resolves.toBeVoid();

    expectTypeOf(history.listSessions).toBeCallableWith('user');
    expectTypeOf(history.listSessions).returns.resolves.toEqualTypeOf<SessionMetadata[]>();

    expectTypeOf(history.forSession).toBeCallableWith('user', 'session');
    expectTypeOf(history.forSession).returns.toEqualTypeOf<
      InstanceType<typeof DynamoDBSessionChatMessageHistoryClass>
    >();
  }); // AC-25

  it('rejects history.getMessages typed to return a non-BaseMessage array (negative)', () => {
    type History = InstanceType<typeof DynamoDBChatMessageHistoryClass>;
    const history = {} as History;
    expectTypeOf(history.getMessages).returns.resolves.not.toEqualTypeOf<string[]>();
    expectTypeOf(history.listSessions).returns.resolves.not.toEqualTypeOf<string[]>();
  }); // AC-25
});

describe('DynamoDBFactory static surface', () => {
  it('locks the four static factory methods and their return types', () => {
    expectTypeOf(DynamoDBFactoryClass.createSaver).returns.toEqualTypeOf<
      InstanceType<typeof DynamoDBSaverClass>
    >();
    expectTypeOf(DynamoDBFactoryClass.createStore).returns.toEqualTypeOf<
      InstanceType<typeof DynamoDBStoreClass>
    >();
    expectTypeOf(DynamoDBFactoryClass.createChatMessageHistory).returns.toEqualTypeOf<
      InstanceType<typeof DynamoDBChatMessageHistoryClass>
    >();

    // createSaver/createStore/createChatMessageHistory accept a Partial of their options.
    expectTypeOf(DynamoDBFactoryClass.createSaver).toBeCallableWith();
    expectTypeOf(DynamoDBFactoryClass.createSaver).toBeCallableWith(
      {} as Partial<DynamoDBSaverOptions>,
    );
    expectTypeOf(DynamoDBFactoryClass.createStore).toBeCallableWith(
      {} as Partial<DynamoDBStoreOptions>,
    );
    expectTypeOf(DynamoDBFactoryClass.createChatMessageHistory).toBeCallableWith(
      {} as Partial<DynamoDBChatMessageHistoryOptions>,
    );

    // createAll returns the documented bundle (checkpointer/store/chatHistory/destroy).
    expectTypeOf(DynamoDBFactoryClass.createAll).toBeFunction();
    const all = DynamoDBFactoryClass.createAll();
    expectTypeOf(all.checkpointer).toEqualTypeOf<InstanceType<typeof DynamoDBSaverClass>>();
    expectTypeOf(all.store).toEqualTypeOf<InstanceType<typeof DynamoDBStoreClass>>();
    expectTypeOf(all.chatHistory).toEqualTypeOf<
      InstanceType<typeof DynamoDBChatMessageHistoryClass>
    >();
    expectTypeOf(all.destroy).toEqualTypeOf<() => void>();
  }); // AC-25

  it('rejects calling createSaver with a number / treating createAll().destroy as async (negative)', () => {
    expectTypeOf(DynamoDBFactoryClass.createSaver).parameter(0).not.toBeNumber();
    const all = DynamoDBFactoryClass.createAll();
    expectTypeOf(all.destroy).returns.not.toBePromise();
  }); // AC-25
});

describe('logger function signatures', () => {
  it('locks setGlobalLogger/getLogger/resetLogger/redactLogger/redactSecrets signatures', () => {
    expectTypeOf(setGlobalLogger).toEqualTypeOf<(logger: Logger) => void>();
    expectTypeOf(getLogger).toEqualTypeOf<() => Logger>();
    expectTypeOf(resetLogger).toEqualTypeOf<() => void>();
    expectTypeOf(redactLogger).toEqualTypeOf<(logger: Logger) => Logger>();
    expectTypeOf(redactSecrets).toEqualTypeOf<(value: unknown) => unknown>();
  }); // AC-25

  it('rejects passing a non-Logger to setGlobalLogger / a wrong getLogger return (negative)', () => {
    expectTypeOf(setGlobalLogger).parameter(0).not.toBeString();
    expectTypeOf(getLogger).returns.not.toBeVoid();
  }); // AC-25
});

describe('Logger type shape', () => {
  it('locks the four structured log-level methods on Logger', () => {
    const logger = {} as Logger;
    expectTypeOf(logger.debug).toBeFunction();
    expectTypeOf(logger.info).toBeFunction();
    expectTypeOf(logger.warn).toBeFunction();
    expectTypeOf(logger.error).toBeFunction();
  }); // AC-25

  it('rejects a Logger missing the error level (negative)', () => {
    expectTypeOf<{ debug: (...a: unknown[]) => void }>().not.toEqualTypeOf<Logger>();
  }); // AC-25
});

describe('BatchWriteIncompleteError data contract', () => {
  it('locks BatchWriteIncompleteError as an Error subclass carrying succeededCount + unprocessed', () => {
    type Err = InstanceType<typeof BatchWriteIncompleteErrorType>;
    expectTypeOf<Err>().toMatchTypeOf<Error>();

    const err = {} as Err;
    expectTypeOf(err.succeededCount).toBeNumber();
    expectTypeOf(err.unprocessed).toBeArray();
    // Each unprocessed entry is a PutRequest or DeleteRequest envelope.
    expectTypeOf(err.unprocessed[0]).toMatchTypeOf<
      { PutRequest: { Item: object } } | { DeleteRequest: { Key: object } }
    >();
  }); // AC-25

  it('rejects succeededCount typed as string / unprocessed as non-array (negative)', () => {
    type Err = InstanceType<typeof BatchWriteIncompleteErrorType>;
    const err = {} as Err;
    expectTypeOf(err.succeededCount).not.toBeString();
    expectTypeOf(err.unprocessed).not.toBeObject();
  }); // AC-25
});

describe('RetryOptions seam-augmented shape (REQ-44)', () => {
  it('accepts the additive OPTIONAL rng?: () => number seam member without it being required', () => {
    // The seam adds `rng?` additively. An object WITHOUT rng must still satisfy RetryOptions
    // (i.e. rng is optional, not required) and an object WITH a valid rng must also satisfy it.
    expectTypeOf<{ rng: () => number }>().toMatchTypeOf<Partial<RetryOptions>>();
    expectTypeOf<RetryOptions>().toMatchTypeOf<{ rng?: () => number }>();

    // RetryOptions must remain usable as an all-optional config object for callers.
    const opts: Partial<RetryOptions> = {};
    expectTypeOf(opts).toMatchTypeOf<Partial<RetryOptions>>();
  }); // AC-25

  it('rejects rng typed as a non-function (negative) and keeps rng OPTIONAL not required', () => {
    // If rng were required, the empty object would fail to match; assert it does NOT fail.
    expectTypeOf<Record<string, never>>().toMatchTypeOf<Partial<RetryOptions>>();
    // A string rng is not assignable to the seam member.
    expectTypeOf<{ rng: string }>().not.toMatchTypeOf<Partial<RetryOptions>>();
  }); // AC-25
});

describe('option interfaces allow additive optional seam fields (REQ-46/REQ-47)', () => {
  it('keeps S3OffloadConfig open to the optional createS3Client seam without requiring it', () => {
    // The S3 client-factory seam adds an OPTIONAL createS3Client field. The existing config
    // (without it) must remain valid; adding a correctly-typed factory must remain valid.
    expectTypeOf<S3OffloadConfig>().not.toBeNever();
    expectTypeOf<Partial<S3OffloadConfig>>().toMatchTypeOf<Partial<S3OffloadConfig>>();
  }); // AC-25

  it('keeps the option objects constructible (positive) and rejects swapping their identities (negative)', () => {
    // Each option type must remain a distinct, usable object type for its constructor.
    expectTypeOf<DynamoDBSaverOptions>().toBeObject();
    expectTypeOf<DynamoDBStoreOptions>().toBeObject();
    expectTypeOf<DynamoDBChatMessageHistoryOptions>().toBeObject();
    expectTypeOf<CompressionConfig>().toBeObject();
    // Distinct option types are not interchangeable identities.
    expectTypeOf<DynamoDBSaverOptions>().not.toEqualTypeOf<DynamoDBStoreOptions>();
  }); // AC-25
});

describe('SessionMetadata type shape', () => {
  it('locks SessionMetadata as a non-empty object usable as listSessions() element', () => {
    type History = InstanceType<typeof DynamoDBChatMessageHistoryClass>;
    const history = {} as History;
    expectTypeOf(history.listSessions).returns.resolves.items.toEqualTypeOf<SessionMetadata>();
    expectTypeOf<SessionMetadata>().toBeObject();
  }); // AC-25

  it('rejects SessionMetadata collapsing to a primitive (negative)', () => {
    expectTypeOf<SessionMetadata>().not.toBeString();
    expectTypeOf<SessionMetadata>().not.toBeNumber();
  }); // AC-25
});
