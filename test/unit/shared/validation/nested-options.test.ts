import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { DynamoDBChatMessageHistory } from '../../../../src/history/chat-message-history';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../../src/store/store';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../../shared/helpers/ddb-mock';

/**
 * The option objects nested inside an adapter's options, checked through each
 * adapter's public constructor: that is the call a caller makes, so a check
 * that exists but is never reached from it would still leave the input
 * accepted.
 */

interface Adapter {
  destroy(): void;
}

type AdapterClass = new (options: never) => Adapter;

const ADAPTERS: [string, AdapterClass][] = [
  ['DynamoDBSaver', DynamoDBSaver],
  ['DynamoDBStore', DynamoDBStore],
  ['DynamoDBChatMessageHistory', DynamoDBChatMessageHistory],
];

/** A client double an adapter can be built on; it never sends. */
function fakeClient() {
  return {
    destroy: jest.fn(),
    config: {},
    middlewareStack: fakeMiddlewareStack(),
    send: jest.fn(),
  };
}

function expectRefused(build: () => Adapter, field: string): void {
  expect(build).toThrow(
    expect.objectContaining({
      code: ErrorCode.VALIDATION,
      context: expect.objectContaining({ field }),
    }),
  );
}

function construct(Adapter: AdapterClass, options: object): Adapter {
  const adapter = new Adapter({ tableName: 'tbl', ...options } as never);
  adapter.destroy();
  return adapter;
}

describe.each(ADAPTERS)('%s nested options', (_name, Adapter) => {
  const injected = (options: object) => () =>
    construct(Adapter, { client: createStrictDocumentMock().client, ...options });
  const built = (options: object) => () => construct(Adapter, options);

  it('refuses a ttl key other than days or seconds, naming that key', () => {
    expectRefused(injected({ ttl: { days: 1, foo: 1 } }), 'ttl.foo');
    expectRefused(injected({ ttl: { seconds: 60, foo: 1 } }), 'ttl.foo');
    expectRefused(injected({ ttl: { day: 1 } }), 'ttl.day');
  });

  it('accepts a ttl in days or in seconds', () => {
    expect(injected({ ttl: { days: 1 } })).not.toThrow();
    expect(injected({ ttl: { seconds: 60 } })).not.toThrow();
  });

  it.each(['x', null, [], 42])('refuses clientConfig %p, naming it', (clientConfig) => {
    expectRefused(built({ clientConfig }), 'clientConfig');
  });

  it('builds its client from a clientConfig holding keys this package never reads', () => {
    const clientConfig = {
      region: 'eu-west-1',
      endpoint: 'http://localhost:8000',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      maxAttempts: 3,
    };
    expect(built({ clientConfig })).not.toThrow();
  });

  /**
   * The keys belong to the AWS SDK, which adds them between releases; an
   * application can run a newer SDK than this package was compiled against,
   * so a key this package's types do not know is still the SDK's to read.
   *
   * The handler's own fields are pinned once, by the shared client's test. The
   * key *set* is still exact here: the subject is that no key is dropped, and
   * a key an adapter adds of its own would otherwise reach the SDK unnamed.
   */
  it('hands every clientConfig key to the SDK, including one it was not compiled with', () => {
    const createClient = jest.fn(() => fakeClient() as never);
    construct(Adapter, {
      clientConfig: { region: 'eu-west-1', newerSdkOption: true },
      createClient,
    });
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      region: 'eu-west-1',
      newerSdkOption: true,
      requestHandler: expect.anything(),
    });
  });

  it.each(['x', null, [], 42])('refuses s3.clientConfig %p, naming it', (clientConfig) => {
    expectRefused(injected({ s3: { bucketName: 'b', clientConfig } }), 's3.clientConfig');
  });

  it('accepts an s3.clientConfig holding S3 client options', () => {
    const clientConfig = { region: 'eu-west-1', maxAttempts: 2, forcePathStyle: true };
    expect(injected({ s3: { bucketName: 'b', clientConfig } })).not.toThrow();
  });

  /** A non-string prefix reached `keyPrefix.endsWith` and escaped as a bare `TypeError`. */
  it.each([123, null, true, {}])('refuses s3.keyPrefix %p, naming it', (keyPrefix) => {
    expectRefused(injected({ s3: { bucketName: 'b', keyPrefix } }), 's3.keyPrefix');
  });

  /** A non-string id was handed to `PutObject` unchecked at the first offload. */
  it.each([123, null, '', ' '])('refuses s3.sseKmsKeyId %p, naming it', (sseKmsKeyId) => {
    expectRefused(injected({ s3: { bucketName: 'b', sseKmsKeyId } }), 's3.sseKmsKeyId');
  });

  it.each(['x', 1, null])('refuses s3.createS3Client %p, naming it', (createS3Client) => {
    expectRefused(injected({ s3: { bucketName: 'b', createS3Client } }), 's3.createS3Client');
  });

  it('accepts a scoped key prefix beside a KMS key id', () => {
    const s3 = {
      bucketName: 'b',
      keyPrefix: 'langgraph/',
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId: '1234abcd-12ab-34cd-56ef-1234567890ab',
    };
    expect(injected({ s3 })).not.toThrow();
  });

  it.each([
    ['client', createStrictDocumentMock().client],
    ['logger', { debug() {}, info() {}, warn() {}, error() {} }],
    ['serde', { dumpsTyped() {}, loadsTyped() {} }],
  ])('refuses an array for %s, naming it rather than its first method', (field, valid) => {
    expectRefused(built({ [field]: [] }), field);
    expect(built({ [field]: valid })).not.toThrow();
  });
});

describe('DynamoDBStore index option', () => {
  const embeddings = {
    embedQuery: () => [0, 0, 0],
    embedDocuments: (texts: string[]) => texts.map(() => [0, 0, 0]),
  };
  const store = (options: object) => () =>
    construct(DynamoDBStore, {
      client: createStrictDocumentMock().client,
      ...options,
    });

  /** A misspelt key used to be reported as the missing one it displaced. */
  it('refuses a key IndexConfig does not declare, before checking embeddings', () => {
    expectRefused(store({ index: { dims: 3, embed: 'x' } }), 'index.embed');
    expectRefused(store({ index: { dims: 3, embed: embeddings } }), 'index.embed');
    expectRefused(store({ index: { dims: 3, embeddings, foo: 1 } }), 'index.foo');
    expectRefused(store({ index: { dims: 3, embeddings, feilds: ['a'] } }), 'index.feilds');
  });

  it.each([null, 'x', [], 42])('refuses index %p, naming it', (index) => {
    expectRefused(store({ index }), 'index');
  });

  it.each(['ab', [1], null])('refuses index.fields %p, naming it', (fields) => {
    expectRefused(store({ index: { dims: 3, embeddings, fields } }), 'index.fields');
  });

  it('still names a missing or unusable embeddings', () => {
    expectRefused(store({ index: { dims: 3 } }), 'index.embeddings');
    expectRefused(store({ index: { dims: 3, embeddings: {} } }), 'index.embeddings.embedQuery');
  });

  it('accepts an index with fields, without them, and with none at all', () => {
    expect(store({ index: { dims: 3, embeddings, fields: ['title', 'body'] } })).not.toThrow();
    expect(store({ index: { dims: 3, embeddings } })).not.toThrow();
    expect(store({})).not.toThrow();
  });

  /**
   * A backend is checked for the methods this package calls and nothing else:
   * it is often a class instance carrying its own state and helpers, and
   * refusing those would refuse a working backend.
   */
  it('accepts a vectorBackend instance carrying members beyond the ones it calls', () => {
    class Backend {
      readonly name = 'memory';
      private readonly rows = new Map<string, number[]>();
      async upsert(): Promise<void> {}
      query(): [] {
        return [];
      }
      async delete(): Promise<void> {}
      size(): number {
        return this.rows.size;
      }
    }
    expect(store({ index: { dims: 3, embeddings }, vectorBackend: new Backend() })).not.toThrow();
  });
});
