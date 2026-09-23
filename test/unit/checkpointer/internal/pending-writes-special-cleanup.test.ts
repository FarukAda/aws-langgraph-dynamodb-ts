import { parseThreadId } from '../../../../src/checkpointer/internal/parse';
import { writeSpecialItemsWithCleanup } from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { rowWrite } from '../../../shared/helpers/ddb-mock';
import { writeItems } from '../../../shared/helpers/parsed-inputs';

/** The bytes are immaterial here, but they may not be none: a payload that
 * serialises to nothing is refused at the encoder. */
const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode('{}')]),
  loadsTyped: (): Promise<unknown> => Promise.resolve(undefined),
};

const descriptor = (s3Key: string) => ({
  location: PayloadLocation.S3 as const,
  serdeType: 'json',
  compressed: false,
  s3Key,
});

/** A pre-built special write item; `sk` distinguishes items within one call. */
function specialItem(
  s3Key: string,
  sk = 'WRITE##c1#task-1#0000000007#__error__',
): CheckpointWriteItem {
  return {
    PK: 't',
    SK: sk,
    taskId: 'task-1',
    index: -1,
    channel: '__error__',
    writeGroup: 'group-1',
    occurrence: 0,
    value: descriptor(s3Key),
  };
}

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: jest.fn(() => true),
  };
}

/**
 * A document-client stub whose `get`/`put` are driven per test. Every item here
 * is offloaded, so its row write goes out as a one-item transaction; `rowWrite`
 * hands the stub the put that transaction carries, so each test still states
 * what it wants of the write in one shape.
 */
interface ClientStub {
  get: (input: Record<string, unknown>) => Promise<{ Item?: Record<string, unknown> }>;
  put: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function context(client: ClientStub, offloader?: ReturnType<typeof trackingOffloader>) {
  return {
    client: { ...client, transactWrite: rowWrite(client.put) } as never,
    tableName: 'ckpt',
    serde,
    logger: SILENT_LOGGER,
    offloader: offloader as never,
  } as unknown as CheckpointerContext;
}

describe('writeSpecialItemsWithCleanup', () => {
  it('is a no-op for an empty items list', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [],
    );
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('a committed item deletes the descriptor it superseded', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({ Item: { value: descriptor('old.bin'), writeGroup: 'g0' } }),
      put: () => Promise.resolve({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [specialItem('new.bin')],
    );
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old.bin']);
  });

  it('an item that definitely never committed deletes its own new upload', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({}),
      put: () => {
        throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [specialItem('new.bin')],
    );
    expect(result).toMatchObject({ message: 'boom' });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['new.bin']);
  });

  it('returns (never throws) the first error when more than one item fails', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({}),
      put: (input) => {
        const item = input.Item as CheckpointWriteItem;
        if (item.SK.endsWith('one')) {
          throw Object.assign(new Error('first'), { name: 'ResourceNotFoundException' });
        }
        throw Object.assign(new Error('second'), { name: 'ResourceNotFoundException' });
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [
        specialItem('one.bin', 'WRITE##c1#task-1#0000000007#one'),
        specialItem('two.bin', 'WRITE##c1#task-1#0000000008#two'),
      ],
    );
    expect(result).toMatchObject({ message: 'first' });
  });

  it('with no offloader configured nothing is deleted', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({ Item: { value: descriptor('old.bin'), writeGroup: 'g0' } }),
      put: () => Promise.resolve({}),
    };
    await expect(
      writeSpecialItemsWithCleanup(context(client), parseThreadId('t'), [specialItem('new.bin')]),
    ).resolves.toBeUndefined();
  });

  it('deletes nothing for a committed item that had no previous row to supersede', async () => {
    const client: ClientStub = {
      get: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [specialItem('new.bin')],
    );
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('cleans up each side of a mixed outcome: the previous object for the committed item, the new upload for the failed one', async () => {
    const client: ClientStub = {
      get: async (input) => {
        const key = input.Key as { SK: string };
        if (key.SK.endsWith('committed')) {
          return Promise.resolve({
            Item: { value: descriptor('committed-old.bin'), writeGroup: 'g0' },
          });
        }
        return {};
      },
      put: async (input) => {
        const item = input.Item as CheckpointWriteItem;
        if (item.SK.endsWith('failed')) {
          throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
        }
        return Promise.resolve({});
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [
        specialItem('committed-new.bin', 'WRITE##c1#task-1#0000000007#committed'),
        specialItem('failed-new.bin', 'WRITE##c1#task-1#0000000008#failed'),
      ],
    );
    expect(result).toMatchObject({ message: 'boom' });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['committed-old.bin']);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['failed-new.bin']);
  });
});

/**
 * The special row a call with `writeGroup` builds for `value`, with the key its
 * upload gets: the real item builder, so the key is the one the call would use.
 */
async function builtItem(value: unknown, writeGroup: string): Promise<CheckpointWriteItem> {
  const offloading = context(
    { get: () => Promise.resolve({}), put: () => Promise.resolve({}) },
    trackingOffloader(),
  );
  const [built] = await writeItems(
    offloading,
    't',
    '',
    'c1',
    'task-1',
    [['__error__', value]],
    writeGroup,
  );
  return built;
}

const keyOf = (built: CheckpointWriteItem): string => (built.value as { s3Key: string }).s3Key;

/**
 * The timeline of C-02b, with every call uploading under its own writeGroup:
 *
 * 1. No row exists when this call reads it, so its put is pinned to "no row".
 * 2. Every attempt at that put times out, so the retry budget is spent.
 * 3. Meanwhile a racer writes a value for the same task and channel — the same
 *    one, or another — under the racer's own writeGroup, so its row names an
 *    object of the racer's own.
 * 4. The verification read finds the racer's writeGroup, so this write did not
 *    land, and the cleanup releases the item's own upload.
 *
 * The invariant is that the racer's committed object is never released.
 */
async function raceOnSpecialRow(racerValue: object | null) {
  const own = await builtItem({ error: 'boom' }, 'group-1');
  const reads = [{}, { Item: { writeGroup: 'group-racer', value: racerValue } }];
  const client: ClientStub = {
    get: () => Promise.resolve(reads.shift() ?? {}),
    put: () => {
      throw Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
    },
  };
  const offloader = trackingOffloader();
  const ctx = {
    ...context(client, offloader),
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  } as CheckpointerContext;
  const error = await writeSpecialItemsWithCleanup(ctx, parseThreadId('t'), [own]);
  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { error, deleted, own: keyOf(own) };
}

describe("writeSpecialItemsWithCleanup never releases a racer's committed object (C-02b)", () => {
  it.each([
    ['the same value', { error: 'boom' }],
    ['another value', { error: 'another' }],
  ])(
    "releases exactly the item's own upload when the racer committed %s",
    async (_label, value) => {
      const racer = await builtItem(value, 'group-racer');
      const { error, deleted, own } = await raceOnSpecialRow(racer.value);
      expect(error).toMatchObject({
        name: 'DynamoDBLangGraphError',
        code: ErrorCode.RETRY_EXHAUSTED,
      });
      expect(own).not.toBe(keyOf(racer));
      expect(deleted).toEqual([own]);
    },
  );

  /** A row this library did not write can hold anything; it names no object, and must not throw. */
  it("still deletes the item's upload, and settles, when the live row's value is null", async () => {
    const { error, deleted, own } = await raceOnSpecialRow(null);
    expect(error).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(deleted).toEqual([own]);
  });

  /**
   * A first read that fails is no verdict read from the row, and the item's own
   * upload is released only on one. No put is issued, and the upload is left to
   * the lifecycle rule.
   */
  it('returns the error, issues no put and deletes nothing when the first read of the row fails', async () => {
    let puts = 0;
    const client: ClientStub = {
      get: () => {
        throw Object.assign(new Error('read down'), { name: 'ValidationException' });
      },
      put: () => {
        puts += 1;
        return Promise.resolve({});
      },
    };
    const offloader = trackingOffloader();
    const error = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [specialItem('new.bin')],
    );
    expect(error).toMatchObject({ message: 'read down' });
    expect(puts).toBe(0);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
});

/**
 * The timeline of a committed special write racing a revert, with every call
 * uploading under its own writeGroup:
 *
 * 1. The row holds a value an earlier call wrote under its writeGroup. This
 *    call reads it and its compare-and-swap commits over it.
 * 2. A racer then commits that same value again, under the racer's own
 *    writeGroup, so its row names an object of its own.
 * 3. This call releases the payload it superseded, without reading the row
 *    again.
 *
 * The invariant is that the racer's committed object is never released.
 */
describe('writeSpecialItemsWithCleanup releases a superseded object without reading the row again', () => {
  it("releases exactly the superseded object, which the racer's committed row does not name", async () => {
    const superseded = await builtItem({ error: 'first' }, 'g0');
    const racer = await builtItem({ error: 'first' }, 'group-racer');
    const own = await builtItem({ error: 'second' }, 'group-1');
    let reads = 0;
    const client: ClientStub = {
      get: () => {
        reads += 1;
        return Promise.resolve({ Item: { value: superseded.value, writeGroup: 'g0' } });
      },
      put: () => Promise.resolve({}),
    };
    const offloader = trackingOffloader();

    const error = await writeSpecialItemsWithCleanup(
      context(client, offloader),
      parseThreadId('t'),
      [own],
    );

    const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
    expect(error).toBeUndefined();
    expect(keyOf(racer)).not.toBe(keyOf(superseded));
    expect(deleted).toEqual([keyOf(superseded)]);
    expect(reads).toBe(1);
  });
});

describe('writeSpecialItemsWithCleanup S3 key binding (SEC-03)', () => {
  it("never deletes a superseded object outside the thread's own path", async () => {
    const client: ClientStub = {
      get: () =>
        Promise.resolve({ Item: { value: descriptor('foreign/old.bin'), writeGroup: 'g0' } }),
      put: () => Promise.resolve({}),
    };
    const offloader = { ...trackingOffloader(), ownsKey: jest.fn(() => false) };
    const warn = jest.fn();
    const ctx = {
      ...context(client, offloader),
      logger: { ...SILENT_LOGGER, warn },
    } as CheckpointerContext;
    await expect(
      writeSpecialItemsWithCleanup(ctx, parseThreadId('t'), [specialItem('new.bin')]),
    ).resolves.toBeUndefined();
    expect(offloader.ownsKey).toHaveBeenCalledWith('foreign/old.bin', ['t']);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
