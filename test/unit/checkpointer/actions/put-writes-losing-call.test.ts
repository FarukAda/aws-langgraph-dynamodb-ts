import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import { buildWriteItems } from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock, rejectRowWrites } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: jest.fn(async (key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

function context(
  client: CheckpointerContext['client'],
  offloader: ReturnType<typeof trackingOffloader>,
): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER, offloader: offloader as never };
}

const CONFIG = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };

/**
 * Two `putWrites` calls can write a value for the same
 * (thread, checkpoint, task, index, channel). That is an ordinary retry of a
 * task, and first-write-wins means exactly one row survives.
 *
 * Every call uploads under its own `writeGroup`, so the two calls address two
 * objects even when they write identical bytes. The loser releases its own
 * upload, which the winner's row never names, and the winner's object is never
 * released.
 */
describe('putWrites when another call already won the row for the same write', () => {
  it.each([
    ['the same value', 'v'],
    ['a different value', 'other'],
  ])(
    "releases exactly its own upload, never the winning row's object, when the winner wrote %s",
    async (_label, winnerValue) => {
      const { client, mock } = createStrictDocumentMock();
      const offloader = trackingOffloader();
      const ctx = context(client, offloader);

      /** The row the winning call left behind, carrying its own writeGroup. */
      const [winner] = await buildWriteItems(
        ctx,
        't',
        '',
        'c1',
        'task-1',
        [['ch', winnerValue]],
        'group-A',
      );
      offloader.upload.mockClear();

      /**
       * The loser's write is offloaded, so it goes out as a one-item
       * transaction and the winner's row comes back attached to a cancellation
       * reason rather than to an exception of its own.
       */
      rejectRowWrites(
        mock,
        Object.assign(new Error('conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            {
              Code: 'ConditionalCheckFailed',
              Item: marshall(winner, { removeUndefinedValues: true }),
            },
          ],
        }),
      );
      mock.on(GetCommand).resolves({ Item: winner });

      await putWrites(ctx, CONFIG, [['ch', 'v']], 'task-1');

      const [own] = offloader.upload.mock.calls.map(([key]) => key);
      const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
      expect(own).not.toBe((winner.value as { s3Key: string }).s3Key);
      expect(deleted).toEqual([own]);
    },
  );
});
