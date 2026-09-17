import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** An offloaded descriptor as the verification read projects it: location and key only. */
const s3 = (s3Key: string) => ({ location: PayloadLocation.S3, s3Key });

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], hash: string) => `${[...parts, hash].join('/')}.bin`,
    upload: jest.fn(async (key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}

function context(
  client: StoreContext['client'],
  offloader: ReturnType<typeof trackingOffloader>,
): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    offloader: offloader as never,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  };
}

const OP: PutOperation = { namespace: ['users', 'u1'], key: 'profile', value: { name: 'Faruk' } };

/**
 * The timeline of C-02a:
 *
 * 1. This call reads row E, which points at `E.bin`, and uploads its value to K.
 * 2. Every attempt at its put times out, so the retry budget is spent.
 * 3. Meanwhile a racer commits the same value: its row carries its own `rev`,
 *    and, because a key is the hash of the bytes under the row's path, K.
 * 4. The verification read finds the racer's `rev`, so this write did not land,
 *    and the cleanup releases this call's own upload.
 *
 * `racerKey` names the object the racer's row points at, given this call's K.
 */
async function raceWithRacerAt(racerKey: (uploaded: string) => string) {
  const { client, mock } = createStrictDocumentMock();
  const offloader = trackingOffloader();
  const uploaded = (): string => offloader.upload.mock.calls[0][0];
  mock.on(GetCommand).callsFake(async (input: { ProjectionExpression: string }) => {
    if (input.ProjectionExpression.startsWith('#c')) {
      return { Item: { createdAt: 'c', rev: 'REV-E', value: s3('users/u1/profile/E.bin') } };
    }
    return { Item: { rev: 'REV-R', value: s3(racerKey(uploaded())) } };
  });
  mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));

  await expect(putItem(context(client, offloader), OP)).rejects.toMatchObject({
    code: ErrorCode.RETRY_EXHAUSTED,
  });

  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { uploaded: uploaded(), deleted };
}

describe('store.put keeps the object a live row names when its write fails ambiguously (C-02a)', () => {
  it("never deletes its own upload when the racer's live row holds the same key", async () => {
    const { uploaded, deleted } = await raceWithRacerAt((own) => own);
    expect(deleted).not.toContain(uploaded);
  });

  it("still deletes its own upload when the racer's live row holds another key", async () => {
    const { uploaded, deleted } = await raceWithRacerAt(() => 'users/u1/profile/R.bin');
    expect(deleted).toEqual([uploaded]);
  });
});

const C1 = { note: 'the original value' };
const C2 = { note: 'the value that overwrites it' };

/** The key `value` is offloaded to, captured by putting it where no row exists. */
async function offloadedKeyOf(value: PutOperation['value']): Promise<string> {
  const { client, mock } = createStrictDocumentMock();
  const offloader = trackingOffloader();
  mock.on(GetCommand).resolves({});
  mock.on(PutCommand).resolves({});
  await putItem(context(client, offloader), { ...OP, value });
  return offloader.upload.mock.calls[0][0];
}

/** What a read answers: a row, no row, or a failure. */
type ReadAnswer = { Item?: Record<string, unknown> } | 'fails';

/**
 * The timeline of a successful overwrite racing a revert:
 *
 * 1. The row holds C1 at K1. This call reads it, uploads C2, and its
 *    compare-and-swap commits.
 * 2. A racer then commits C1 again. Its row carries its own `rev` and, because a
 *    key is the hash of the bytes under the row's path, K1.
 * 3. This call releases the payload it superseded, K1.
 *
 * `after` is the answer to every read following `readExisting`, given this
 * call's own upload and K1.
 */
async function overwriteThenRead(after: (own: string, k1: string) => ReadAnswer) {
  const k1 = await offloadedKeyOf(C1);
  const { client, mock } = createStrictDocumentMock();
  const offloader = trackingOffloader();
  const debug = jest.fn();
  mock.on(GetCommand).callsFake(async (input: { ProjectionExpression: string }) => {
    if (input.ProjectionExpression.startsWith('#c')) {
      return { Item: { createdAt: 'c', rev: 'REV-E', value: s3(k1) } };
    }
    const answer = after(offloader.upload.mock.calls[0][0], k1);
    if (answer === 'fails') {
      throw Object.assign(new Error('read down'), { name: 'ValidationException' });
    }
    return answer;
  });
  mock.on(PutCommand).resolves({});

  const ctx = { ...context(client, offloader), logger: { ...SILENT_LOGGER, debug } };
  await expect(putItem(ctx, { ...OP, value: C2 })).resolves.toBeUndefined();

  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { k1, deleted, debug };
}

describe('store.put reads the row before releasing the payload a successful overwrite superseded', () => {
  it("never deletes the superseded object when a racer's row committed after the swap names it", async () => {
    const { k1, deleted } = await overwriteThenRead((_own, key) => ({
      Item: { rev: 'REV-R', value: s3(key) },
    }));
    expect(deleted).not.toContain(k1);
  });

  it('still deletes the superseded object when the row after the swap holds this write', async () => {
    const { k1, deleted } = await overwriteThenRead((own) => ({
      Item: { rev: 'REV-A', value: s3(own) },
    }));
    expect(deleted).toEqual([k1]);
  });

  /** A read that establishes nothing licenses nothing: the object is left to the lifecycle rule. */
  it('deletes nothing, still resolves, and logs at debug when that read fails', async () => {
    const { deleted, debug } = await overwriteThenRead(() => 'fails');
    expect(deleted).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'store.put: the row could not be read back; the superseded object is left to the lifecycle rule',
      { namespace: OP.namespace, key: OP.key },
    );
  });

  /** The read is spent only when the superseded value names an object this write does not. */
  it.each<[string, (own: string) => ReadAnswer]>([
    [
      'is inline',
      () => ({ Item: { createdAt: 'c', rev: 'REV-E', value: { location: 'INLINE' } } }),
    ],
    ['is absent', () => ({})],
    [
      'has the key of this write',
      (own) => ({ Item: { createdAt: 'c', rev: 'REV-E', value: s3(own) } }),
    ],
  ])('reads nothing past readExisting when the superseded value %s', async (_label, existing) => {
    const own = await offloadedKeyOf(C2);
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    mock.on(GetCommand).resolves(existing(own) as never);
    mock.on(PutCommand).resolves({});

    await putItem(context(client, offloader), { ...OP, value: C2 });

    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
});
