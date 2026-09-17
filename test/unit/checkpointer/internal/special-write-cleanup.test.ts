import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { writeSpecialItemsWithCleanup } from '../../../../src/checkpointer/internal/special-write-cleanup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => undefined,
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

/**
 * The row as `specialItem` commits it. A committed item reads its row again
 * before releasing what it superseded, and this is the answer that lets it.
 */
const ownRow = (s3Key: string) => ({ Item: { value: descriptor(s3Key), writeGroup: 'group-1' } });

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], hash: string) => [...parts, hash].join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: jest.fn(() => true),
  };
}

/** A document-client stub whose `get`/`put` are driven per test. */
interface ClientStub {
  get: (input: Record<string, unknown>) => Promise<{ Item?: Record<string, unknown> }>;
  put: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function context(client: ClientStub, offloader?: ReturnType<typeof trackingOffloader>) {
  return {
    client: client as never,
    tableName: 'ckpt',
    serde,
    logger: SILENT_LOGGER,
    offloader: offloader as never,
  } as unknown as CheckpointerContext;
}

describe('writeSpecialItemsWithCleanup', () => {
  it('is a no-op for an empty items list', async () => {
    const client: ClientStub = {
      get: async () => ({}),
      put: async () => ({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', []);
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('a committed item deletes the descriptor it superseded', async () => {
    const reads = [{ Item: { value: descriptor('old.bin'), writeGroup: 'g0' } }];
    const client: ClientStub = {
      get: async () => reads.shift() ?? ownRow('new.bin'),
      put: async () => ({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('new.bin'),
    ]);
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old.bin']);
  });

  it('an item that definitely never committed deletes its own new upload', async () => {
    const client: ClientStub = {
      get: async () => ({}),
      put: async () => {
        throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('new.bin'),
    ]);
    expect(result).toMatchObject({ message: 'boom' });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['new.bin']);
  });

  it('returns (never throws) the first error when more than one item fails', async () => {
    const client: ClientStub = {
      get: async () => ({}),
      put: async (input) => {
        const item = input.Item as CheckpointWriteItem;
        if (item.SK.endsWith('one')) {
          throw Object.assign(new Error('first'), { name: 'ResourceNotFoundException' });
        }
        throw Object.assign(new Error('second'), { name: 'ResourceNotFoundException' });
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('one.bin', 'WRITE##c1#task-1#0000000007#one'),
      specialItem('two.bin', 'WRITE##c1#task-1#0000000008#two'),
    ]);
    expect(result).toMatchObject({ message: 'first' });
  });

  it('with no offloader configured nothing is deleted', async () => {
    const client: ClientStub = {
      get: async () => ({ Item: { value: descriptor('old.bin'), writeGroup: 'g0' } }),
      put: async () => ({}),
    };
    await expect(
      writeSpecialItemsWithCleanup(context(client), 't', [specialItem('new.bin')]),
    ).resolves.toBeUndefined();
  });

  it('deletes nothing for a committed item that had no previous row to supersede', async () => {
    const client: ClientStub = {
      get: async () => ({}),
      put: async () => ({}),
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('new.bin'),
    ]);
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('cleans up each side of a mixed outcome: the previous object for the committed item, the new upload for the failed one', async () => {
    let committedReads = 0;
    const client: ClientStub = {
      get: async (input) => {
        const key = input.Key as { SK: string };
        if (key.SK.endsWith('committed')) {
          committedReads += 1;
          if (committedReads > 1) return ownRow('committed-new.bin');
          return { Item: { value: descriptor('committed-old.bin'), writeGroup: 'g0' } };
        }
        return {};
      },
      put: async (input) => {
        const item = input.Item as CheckpointWriteItem;
        if (item.SK.endsWith('failed')) {
          throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
        }
        return {};
      },
    };
    const offloader = trackingOffloader();
    const result = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('committed-new.bin', 'WRITE##c1#task-1#0000000007#committed'),
      specialItem('failed-new.bin', 'WRITE##c1#task-1#0000000008#failed'),
    ]);
    expect(result).toMatchObject({ message: 'boom' });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['committed-old.bin']);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['failed-new.bin']);
  });
});

/**
 * The timeline of C-02b:
 *
 * 1. No row exists when this call reads it, so its put is pinned to "no row".
 * 2. Every attempt at that put times out, so the retry budget is spent.
 * 3. Meanwhile a racer writes the same value for the same task and channel. Its
 *    row carries its own writeGroup and, because a key is the hash of the bytes
 *    under the row's path, `racerKey`.
 * 4. The verification read finds the racer's writeGroup, so this write did not
 *    land, and the cleanup releases the item's own upload.
 *
 * `racerValue` is what the racer's row holds under `value`.
 */
async function raceOnSpecialRow(racerValue: object | null) {
  const reads = [{}, { Item: { writeGroup: 'group-racer', value: racerValue } }];
  const client: ClientStub = {
    get: async () => reads.shift() ?? {},
    put: async () => {
      throw Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
    },
  };
  const offloader = trackingOffloader();
  const ctx = {
    ...context(client, offloader),
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  } as CheckpointerContext;
  const error = await writeSpecialItemsWithCleanup(ctx, 't', [specialItem('new.bin')]);
  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { error, deleted };
}

describe('writeSpecialItemsWithCleanup keeps the object a live row names (C-02b)', () => {
  it("never deletes the item's upload when the racer's live row holds the same key", async () => {
    const { error, deleted } = await raceOnSpecialRow(descriptor('new.bin'));
    expect(error).toMatchObject({ name: 'RetryExhaustedError' });
    expect(deleted).not.toContain('new.bin');
  });

  it("still deletes the item's upload when the racer's live row holds another key", async () => {
    const { error, deleted } = await raceOnSpecialRow(descriptor('racer.bin'));
    expect(error).toMatchObject({ name: 'RetryExhaustedError' });
    expect(deleted).toEqual(['new.bin']);
  });

  /** A row this library did not write can hold anything; it names no object, and must not throw. */
  it("still deletes the item's upload, and settles, when the live row's value is null", async () => {
    const { error, deleted } = await raceOnSpecialRow(null);
    expect(error).toMatchObject({ name: 'RetryExhaustedError' });
    expect(deleted).toEqual(['new.bin']);
  });

  /**
   * A first read that fails establishes nothing about the row, and a racer may
   * already hold it with this item's key. No put is issued, and the upload is
   * kept rather than deleted.
   */
  it('returns the error, issues no put and deletes nothing when the first read of the row fails', async () => {
    let puts = 0;
    const client: ClientStub = {
      get: async () => {
        throw Object.assign(new Error('read down'), { name: 'ValidationException' });
      },
      put: async () => {
        puts += 1;
        return {};
      },
    };
    const offloader = trackingOffloader();
    const error = await writeSpecialItemsWithCleanup(context(client, offloader), 't', [
      specialItem('new.bin'),
    ]);
    expect(error).toMatchObject({ message: 'read down' });
    expect(puts).toBe(0);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
});

/**
 * The timeline of a committed special write racing a revert:
 *
 * 1. The row holds a descriptor at `superseded`. This call reads it and its
 *    compare-and-swap commits `new.bin` over it.
 * 2. A racer then commits the value `superseded` holds. Its row carries its own
 *    writeGroup and, because a key is the hash of the bytes under the row's
 *    path, `superseded`.
 * 3. This call releases the payload it superseded.
 *
 * The answers follow time, not the order of the reads. Every read issued
 * before the put sees the superseded row, and `after` answers every read issued
 * once the put has been, so a cleanup that took its row from a read before the
 * commit would see `superseded` named and keep it.
 */
async function commitThenRead(superseded: string, after: object | 'fails') {
  let reads = 0;
  let committed = false;
  const client: ClientStub = {
    get: async () => {
      reads += 1;
      if (!committed) return { Item: { value: descriptor(superseded), writeGroup: 'g0' } };
      if (after === 'fails') {
        throw Object.assign(new Error('read down'), { name: 'ValidationException' });
      }
      return after;
    },
    put: async () => {
      committed = true;
      return {};
    },
  };
  const offloader = trackingOffloader();
  const debug = jest.fn();
  const ctx = {
    ...context(client, offloader),
    logger: { ...SILENT_LOGGER, debug },
  } as CheckpointerContext;
  const error = await writeSpecialItemsWithCleanup(ctx, 't', [specialItem('new.bin')]);
  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { error, deleted, reads, debug };
}

describe('writeSpecialItemsWithCleanup reads the row before releasing a superseded object', () => {
  it("keeps the superseded object when a racer's row committed after this write names it", async () => {
    const { error, deleted } = await commitThenRead('old.bin', {
      Item: { writeGroup: 'group-racer', value: descriptor('old.bin') },
    });
    expect(error).toBeUndefined();
    expect(deleted).not.toContain('old.bin');
  });

  it("deletes the superseded object when the row holds this item's own value", async () => {
    const { error, deleted, reads } = await commitThenRead('old.bin', {
      Item: { writeGroup: 'group-1', value: descriptor('new.bin') },
    });
    expect(error).toBeUndefined();
    expect(deleted).toEqual(['old.bin']);
    expect(reads).toBe(2);
  });

  /** A read that establishes nothing licenses nothing: the object is left to the lifecycle rule. */
  it('deletes nothing, reports no failure, and logs at debug when that read fails', async () => {
    const { error, deleted, debug } = await commitThenRead('old.bin', 'fails');
    expect(error).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'putWrites: the row could not be read back; the superseded object is left to the lifecycle rule',
      { sortKey: 'WRITE##c1#task-1#0000000007#__error__' },
    );
  });

  it("issues no second read when the superseded key is the item's own", async () => {
    const { deleted, reads } = await commitThenRead('new.bin', 'fails');
    expect(reads).toBe(1);
    expect(deleted).toEqual([]);
  });
});

describe('writeSpecialItemsWithCleanup S3 key binding (SEC-03)', () => {
  it("never deletes a superseded object outside the thread's own path", async () => {
    const reads = [{ Item: { value: descriptor('foreign/old.bin'), writeGroup: 'g0' } }];
    const client: ClientStub = {
      get: async () => reads.shift() ?? ownRow('new.bin'),
      put: async () => ({}),
    };
    const offloader = { ...trackingOffloader(), ownsKey: jest.fn(() => false) };
    const warn = jest.fn();
    const ctx = {
      ...context(client, offloader),
      logger: { ...SILENT_LOGGER, warn },
    } as CheckpointerContext;
    await expect(
      writeSpecialItemsWithCleanup(ctx, 't', [specialItem('new.bin')]),
    ).resolves.toBeUndefined();
    expect(offloader.ownsKey).toHaveBeenCalledWith('foreign/old.bin', ['t']);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
