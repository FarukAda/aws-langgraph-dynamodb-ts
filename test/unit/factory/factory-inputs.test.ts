import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { DynamoDBFactory } from '../../../src/factory/factory';
import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { MAX_LOGGED_VALUE_CHARS, truncateForLog } from '../../../src/shared/logging/truncate';
import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../shared/helpers/ddb-mock';

/**
 * What the factory does with arguments it cannot use. `createSaver`,
 * `createStore` and `createChatMessageHistory` each take one adapter's
 * options, and each `createAll` section is one adapter's options, so all four
 * name a mistake the way that adapter's own constructor names it.
 */

function fakeClientFactory() {
  const destroy = jest.fn();
  const client = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
  return { destroy, create: jest.fn(() => client as never) };
}

function expectRefused(build: () => object, field: string): void {
  expect(build).toThrow(
    expect.objectContaining({
      code: ErrorCode.VALIDATION,
      context: expect.objectContaining({ field }),
    }),
  );
}

const NOT_OBJECTS = [null, undefined, 'x', 42, []];

describe('create* refuses options that are not an object', () => {
  const factory = () => new DynamoDBFactory({ client: createStrictDocumentMock().client });

  /**
   * `null` and `undefined` crashed with a bare `TypeError` reading `client` off
   * them, a string was spread into its characters and reported as `options.0`,
   * and a number or an array was spread into nothing and reported as a missing
   * `tableName`.
   */
  it.each(NOT_OBJECTS)('names options for %p, as the adapter itself does', (options) => {
    const f = factory();
    expectRefused(() => f.createSaver(options as never), 'options');
    expectRefused(() => f.createStore(options as never), 'options');
    expectRefused(() => f.createChatMessageHistory(options as never), 'options');
  });

  it('names a mistake inside the options as the adapter does', () => {
    const f = factory();
    expectRefused(() => f.createSaver({ tableName: 'tbl', foo: 1 } as never), 'options.foo');
    expectRefused(() => f.createStore({} as never), 'tableName');
    expectRefused(() => f.createChatMessageHistory({ tableName: 'bad#' }), 'tableName');
  });

  it('builds each adapter from valid options', () => {
    const f = factory();
    expect(f.createSaver({ tableName: 'tbl' })).toBeInstanceOf(DynamoDBSaver);
    expect(f.createStore({ tableName: 'tbl' })).toBeInstanceOf(DynamoDBStore);
    expect(f.createChatMessageHistory({ tableName: 'tbl' })).toBeInstanceOf(
      DynamoDBChatMessageHistory,
    );
  });
});

describe('createAll refuses a section that is not an object', () => {
  it.each([null, 'x', 42, []])(
    'names options for a %p section, before building a client',
    (section) => {
      for (const name of ['saver', 'store', 'history']) {
        const fake = fakeClientFactory();
        const f = new DynamoDBFactory({ createClient: fake.create });
        expectRefused(() => f.createAll({ [name]: section }), 'options');
        expect(fake.create).not.toHaveBeenCalled();
      }
    },
  );

  it('skips a section given as undefined, as it skips an omitted one', () => {
    const f = new DynamoDBFactory({ client: createStrictDocumentMock().client });
    const all = f.createAll({ saver: undefined, store: { tableName: 'tbl' } });
    expect(all.saver).toBeUndefined();
    expect(all.store).toBeInstanceOf(DynamoDBStore);
    all.destroy();
  });

  it('names a mistake inside a section as the adapter does', () => {
    const f = new DynamoDBFactory({ client: createStrictDocumentMock().client });
    expectRefused(
      () => f.createAll({ saver: { tableName: 'tbl', foo: 1 } as never }),
      'options.foo',
    );
  });
});

describe('the factory checks the shape of its own clientConfig', () => {
  /**
   * `createAll` hands its adapters the client built from this config, never
   * the config itself, so no adapter would ever see a malformed one.
   */
  it.each(['x', null, [], 42])(
    'refuses clientConfig %p where the caller wrote it',
    (clientConfig) => {
      expectRefused(() => new DynamoDBFactory({ clientConfig } as never), 'clientConfig');
    },
  );

  /**
   * The handler's own fields are pinned once, by the shared client's test,
   * which is the one place that should have to change when a default moves.
   * The key *set* is still exact here: the subject is that no key is dropped,
   * and a key the factory adds of its own would otherwise reach the SDK with
   * no test naming it.
   */
  it('hands every clientConfig key to the shared client, including ones this package never reads', () => {
    const fake = fakeClientFactory();
    const clientConfig = {
      region: 'eu-west-1',
      endpoint: 'http://localhost:8000',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      maxAttempts: 3,
    };
    const f = new DynamoDBFactory({ clientConfig, createClient: fake.create });
    f.createAll({ saver: { tableName: 'tbl' } }).destroy();
    expect(fake.create).toHaveBeenCalledWith({
      ...clientConfig,
      requestHandler: expect.anything(),
    });
  });
});

describe('the factory checks the logger it logs through itself', () => {
  /**
   * `createAll` logs a teardown failure through the factory's own logger, apart
   * from any adapter. A malformed one threw from inside that teardown, and in
   * the rollback of a failed build replaced the constructor's error with a bare
   * `TypeError`.
   */
  it.each([
    ['x', 'logger'],
    [null, 'logger'],
    [{ debug() {}, info() {}, error() {} }, 'logger.warn'],
  ])('refuses logger %p where the caller wrote it, naming %s', (logger, field) => {
    expectRefused(() => new DynamoDBFactory({ logger } as never), field);
  });

  it('logs a teardown failure through a valid logger and still reports the build error', () => {
    const warn = jest.fn();
    const logger = { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() };
    const client = {
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
      destroy: () => {
        throw new Error('socket already closed');
      },
    };
    const f = new DynamoDBFactory({ logger, createClient: () => client as never });
    expectRefused(
      () => f.createAll({ saver: { tableName: 'tbl' }, store: { tableName: 'bad#' } }),
      'tableName',
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('createAll leaves a malformed shared s3 for the adapter to refuse', () => {
  /** A `null` base `s3` crashed reading `clientConfig` off it, and leaked the shared client. */
  it('names s3 for a shared s3 that is not an object, and releases the shared client', () => {
    for (const s3 of [null, 'x']) {
      const fake = fakeClientFactory();
      const f = new DynamoDBFactory({
        clientConfig: { region: 'eu-west-1' },
        createClient: fake.create,
        s3: s3 as never,
      });
      expectRefused(() => f.createAll({ saver: { tableName: 'tbl' } }), 's3');
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    }
  });

  /** Filling the region in used to turn a malformed config into an accepted one. */
  it('names s3.clientConfig rather than filling a region into one that is not an object', () => {
    for (const clientConfig of ['x', null, []]) {
      const f = new DynamoDBFactory({
        clientConfig: { region: 'eu-west-1' },
        createClient: fakeClientFactory().create,
        s3: { bucketName: 'b', clientConfig } as never,
      });
      expectRefused(() => f.createAll({ saver: { tableName: 'tbl' } }), 's3.clientConfig');
    }
  });

  /** A non-string prefix reached `keyPrefix.endsWith` and escaped as a bare `TypeError`. */
  it.each([123, null])(
    'names s3.keyPrefix for a shared prefix of %p, on every route',
    (keyPrefix) => {
      const f = new DynamoDBFactory({
        client: createStrictDocumentMock().client,
        s3: { bucketName: 'b', keyPrefix } as never,
      });
      expectRefused(() => f.createAll({ saver: { tableName: 'tbl' } }), 's3.keyPrefix');
      expectRefused(() => f.createSaver({ tableName: 'tbl' }), 's3.keyPrefix');
    },
  );

  it('builds an adapter from a shared s3 with a scoped key prefix', () => {
    const f = new DynamoDBFactory({
      client: createStrictDocumentMock().client,
      s3: { bucketName: 'b', keyPrefix: 'langgraph/' },
    });
    f.createAll({ saver: { tableName: 'tbl' } }).destroy();
    expect(f.createSaver({ tableName: 'tbl' })).toBeInstanceOf(DynamoDBSaver);
  });
});

/**
 * Teardown reports the name of whatever an adapter's `close` threw rather than
 * its text. That close is a caller-supplied client's own `destroy`, so nothing
 * this package ran checked how long the name is, while `message` is already
 * bounded where `redactedMessage` relays it — and relaying one half whole
 * would split what is one value.
 */
describe('factory.destroy bounds the failure it names', () => {
  it('cuts an adapter teardown error name past the log cap', () => {
    const name = 'D'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const client = {
      destroy: () => {
        throw Object.assign(new Error('socket already closed'), { name });
      },
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const factory = new DynamoDBFactory({ createClient: () => client as never, logger });

    const all = factory.createAll({ saver: { tableName: 'ckpt' } });
    expect(() => all.destroy()).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not release'), {
      reason: truncateForLog(name),
    });
  });
});
