import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { releaseOwned } from '../../../src/shared/release';
import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> =>
    await Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    await Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

/**
 * An S3 client whose sockets are already gone: its own `destroy` throws, which
 * is what a teardown written as a sequence of statements stops at.
 */
function hostileS3Client(): unknown {
  return {
    send: (): unknown => ({}),
    destroy: (): never => {
      throw new Error('socket already closed');
    },
    config: {},
  };
}

/** A DynamoDB client this adapter builds and therefore owns, with a watched release. */
function ownedClientFactory(): { destroy: jest.Mock; create: () => never } {
  const destroy = jest.fn();
  const client = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
  return { destroy, create: () => client as never };
}

/** An adapter that owns its DynamoDB client and offloads to a hostile S3 one. */
function optionsFor(create: () => never): Record<string, unknown> {
  return {
    tableName: 'tbl',
    serde,
    logger: SILENT_LOGGER,
    ttl: { days: 30 },
    clientConfig: { region: 'us-east-1' },
    createClient: create,
    s3: { bucketName: 'b', createS3Client: () => hostileS3Client() },
  };
}

/** The teardown surface every adapter offers, whatever else it does. */
interface Adapter {
  ensureS3LifecycleRule(): Promise<void>;
  destroy(): void;
}

const ADAPTERS: readonly [string, (options: never) => Adapter][] = [
  ['DynamoDBSaver', (options) => new DynamoDBSaver(options)],
  ['DynamoDBStore', (options) => new DynamoDBStore(options)],
  ['DynamoDBChatMessageHistory', (options) => new DynamoDBChatMessageHistory(options)],
];

/**
 * Build one adapter, make it resolve its S3 client (nothing is released before
 * one exists), then tear it down and report what happened.
 */
async function teardownOf(
  build: (options: never) => Adapter,
): Promise<{ raised: string | undefined; clientReleases: number }> {
  const owned = ownedClientFactory();
  const adapter = build(optionsFor(owned.create) as never);
  await adapter.ensureS3LifecycleRule();
  let raised: string | undefined;
  try {
    adapter.destroy();
  } catch (error) {
    raised = (error as Error).message;
  }
  return { raised, clientReleases: owned.destroy.mock.calls.length };
}

/**
 * Teardown is a sequence of resources and the first throw used to end it, so
 * everything after it was stranded with no reference left to reach it by. All
 * three adapters released the S3 offloader first and the DynamoDB client they
 * built second, so a client whose sockets had already gone leaked the other one
 * for the life of the process — under a clause that read "nothing this adapter
 * raises", which a caller reads as nothing at all.
 */
describe('an adapter releases every resource it owns, whatever one of them does', () => {
  it.each(ADAPTERS)('%s releases the client behind the failing resource', async (_name, build) => {
    expect(await teardownOf(build)).toEqual({
      raised: 'socket already closed',
      clientReleases: 1,
    });
  });

  it('answers alike on all three, so no adapter leaks where another releases', async () => {
    const answers = await Promise.all(ADAPTERS.map(([, build]) => teardownOf(build)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  /**
   * A client the caller injected stays theirs: it may be shared with their own
   * code and with the other two adapters, so a failing offloader must not turn
   * into a reason to close it.
   */
  it.each(ADAPTERS)('%s still never closes a client it was given', async (_name, build) => {
    const { client } = createStrictDocumentMock();
    const destroy = jest.spyOn(client, 'destroy');
    const adapter = build({
      tableName: 'tbl',
      serde,
      logger: SILENT_LOGGER,
      ttl: { days: 30 },
      client,
      s3: { bucketName: 'b', createS3Client: () => hostileS3Client() },
    } as never);
    await adapter.ensureS3LifecycleRule();
    expect(() => adapter.destroy()).toThrow('socket already closed');
    expect(destroy).not.toHaveBeenCalled();
  });

  /** `stop()` is the upstream lifecycle hook; it is `destroy()` and must behave as one. */
  it('releases the same way through the store lifecycle hook', async () => {
    const owned = ownedClientFactory();
    const store = new DynamoDBStore(optionsFor(owned.create) as never);
    await store.ensureS3LifecycleRule();
    expect(() => store.stop()).toThrow('socket already closed');
    expect(owned.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('releaseOwned', () => {
  it('releases every resource in order and raises nothing when none fails', () => {
    const order: string[] = [];
    expect(() =>
      releaseOwned([
        { destroy: () => order.push('first') },
        undefined,
        { destroy: () => order.push('second') },
      ]),
    ).not.toThrow();
    expect(order).toEqual(['first', 'second']);
  });

  /** The whole point: a failure may not stop the resources behind it being offered a release. */
  it('offers every later resource its release and then raises the first failure', () => {
    const later = jest.fn();
    expect(() =>
      releaseOwned([
        {
          destroy: () => {
            throw new Error('first failure');
          },
        },
        {
          destroy: () => {
            throw new Error('second failure');
          },
        },
        { destroy: later },
      ]),
    ).toThrow('first failure');
    expect(later).toHaveBeenCalledTimes(1);
  });

  /**
   * A client is foreign code and may throw anything a `throw` produces, so the
   * caller's `catch` is handed an `Error` whatever it was given.
   */
  it('normalises a resource that throws something that is not an error', () => {
    let caught: unknown;
    try {
      releaseOwned([
        {
          destroy: () => {
            throw 'closed';
          },
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('closed');
  });
});
