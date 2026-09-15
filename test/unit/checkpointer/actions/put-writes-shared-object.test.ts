import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import { buildWriteItems } from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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
    buildKey: (parts: readonly string[], hash: string) => [...parts, hash].join('/'),
    upload: async (key: string) => key,
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
 * Two `putWrites` calls can write the same value for the same
 * (thread, checkpoint, task, index, channel). That is an ordinary retry of a
 * task, and first-write-wins means exactly one row survives.
 *
 * Because a payload is addressed by its content hash under that row's own path,
 * both calls upload to the *same* object. The loser must therefore not delete
 * "its own dead upload": the winner's live row points at it.
 */
describe('putWrites when two calls upload identical bytes for one write', () => {
  it('never deletes the object the winning row still points at', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    const ctx = context(client, offloader);

    /** The row the winning call left behind, carrying its own writeGroup. */
    const [winner] = await buildWriteItems(ctx, 't', '', 'c1', 'task-1', [['ch', 'v']], 'group-A');

    mock.on(PutCommand).rejects(
      Object.assign(new Error('conflict'), {
        name: 'ConditionalCheckFailedException',
        Item: marshall(winner, { removeUndefinedValues: true }),
      }),
    );
    mock.on(GetCommand).resolves({ Item: winner });

    await putWrites(ctx, CONFIG, [['ch', 'v']], 'task-1');

    const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
    expect(deleted).not.toContain((winner.value as { s3Key: string }).s3Key);
  });

  /**
   * The same rejection when the winner stored a *different* value still frees
   * the loser's object: nothing references it, and leaving it would be a leak.
   */
  it('still deletes its own upload when the winning row points elsewhere', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    const ctx = context(client, offloader);

    const [winner] = await buildWriteItems(
      ctx,
      't',
      '',
      'c1',
      'task-1',
      [['ch', 'other']],
      'group-A',
    );
    const [loser] = await buildWriteItems(ctx, 't', '', 'c1', 'task-1', [['ch', 'v']], 'group-B');

    mock.on(PutCommand).rejects(
      Object.assign(new Error('conflict'), {
        name: 'ConditionalCheckFailedException',
        Item: marshall(winner, { removeUndefinedValues: true }),
      }),
    );
    mock.on(GetCommand).resolves({ Item: winner });

    await putWrites(ctx, CONFIG, [['ch', 'v']], 'task-1');

    const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
    expect(deleted).toContain((loser.value as { s3Key: string }).s3Key);
  });
});
