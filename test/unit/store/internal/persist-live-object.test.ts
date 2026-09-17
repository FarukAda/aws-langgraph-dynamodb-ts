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
