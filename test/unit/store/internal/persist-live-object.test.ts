import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => `${[...parts, objectId].join('/')}.bin`,
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

/** A committed row as a store put writes it: its revision, and its value's location and key. */
interface CommittedRow {
  rev: string;
  value: { location: PayloadLocation; s3Key: string };
}

/** The row another put of `value` commits, captured by letting that put land on an empty item. */
async function rowCommittedBy(value: PutOperation['value']): Promise<CommittedRow> {
  const { client, mock } = createStrictDocumentMock();
  let row: CommittedRow | undefined;
  mock.on(GetCommand).resolves({});
  mock.on(PutCommand).callsFake(async (input: { Item: CommittedRow }) => {
    row = { rev: input.Item.rev, value: input.Item.value };
    return {};
  });
  await putItem(context(client, trackingOffloader()), { ...OP, value });
  return row!;
}

const deletedBy = (offloader: ReturnType<typeof trackingOffloader>): string[] =>
  offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);

/**
 * The timeline of C-02a, with every put uploading under its own `rev`:
 *
 * 1. This call reads row E and uploads its value under its own `rev`.
 * 2. Every attempt at its put times out, so the retry budget is spent.
 * 3. Meanwhile a racer commits a value — the same one, or another — under the
 *    racer's own `rev`, so its row names an object of the racer's own.
 * 4. The verification read finds the racer's `rev`, so this write did not land,
 *    and the cleanup releases this call's upload.
 *
 * The invariant is that the racer's committed object is never released.
 */
describe("store.put never releases a racer's committed object when its own write fails ambiguously (C-02a)", () => {
  it.each([
    ['the same value', OP.value],
    ['another value', { name: 'someone else' }],
  ])('releases exactly its own upload when the racer committed %s', async (_label, value) => {
    const racer = await rowCommittedBy(value);
    const earlier = await rowCommittedBy({ name: 'the value row E holds' });
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    mock
      .on(GetCommand)
      .callsFake(async (input: { ProjectionExpression: string }) =>
        input.ProjectionExpression.startsWith('#c')
          ? { Item: { createdAt: 'c', ...earlier } }
          : { Item: racer },
      );
    mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));

    await expect(putItem(context(client, offloader), OP)).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
      name: 'RetryExhaustedError',
    });

    const own: string = offloader.upload.mock.calls[0][0];
    expect(own).not.toBe(racer.value.s3Key);
    expect(deletedBy(offloader)).toEqual([own]);
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });
});

/**
 * The timeline of a successful overwrite racing a revert, with every put
 * uploading under its own `rev`:
 *
 * 1. The row holds C1, committed by an earlier put under that put's `rev`. This
 *    call reads it, uploads C2 under its own, and its compare-and-swap commits.
 * 2. A racer then commits C1 again, under the racer's own `rev`, so its row
 *    names an object of its own, not the one the earlier put uploaded.
 * 3. This call releases the payload it superseded without reading the row again.
 *
 * The invariant is that the racer's committed object is never released.
 */
describe('store.put releases the payload a successful overwrite superseded without reading the row again', () => {
  it("releases exactly the superseded object, which the racer's committed row does not name", async () => {
    const superseded = await rowCommittedBy({ note: 'C1' });
    const racer = await rowCommittedBy({ note: 'C1' });
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    mock.on(GetCommand).resolves({ Item: { createdAt: 'c', ...superseded } });
    mock.on(PutCommand).resolves({});

    await expect(
      putItem(context(client, offloader), { ...OP, value: { note: 'C2' } }),
    ).resolves.toBeUndefined();

    expect(racer.value.s3Key).not.toBe(superseded.value.s3Key);
    expect(deletedBy(offloader)).toEqual([superseded.value.s3Key]);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it.each([
    ['is inline', { Item: { createdAt: 'c', rev: 'REV-E', value: { location: 'INLINE' } } }],
    ['is absent', {}],
  ])(
    'releases nothing and reads nothing past readExisting when the superseded value %s',
    async (_label, existing) => {
      const { client, mock } = createStrictDocumentMock();
      const offloader = trackingOffloader();
      mock.on(GetCommand).resolves(existing as never);
      mock.on(PutCommand).resolves({});

      await putItem(context(client, offloader), { ...OP, value: { note: 'C2' } });

      expect(mock.commandCalls(GetCommand)).toHaveLength(1);
      expect(deletedBy(offloader)).toEqual([]);
    },
  );
});
