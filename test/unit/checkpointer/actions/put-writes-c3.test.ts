import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
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

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

function conditionalCheckFailed(): Error {
  return Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
}

/**
 * C3: a write's sort-key index used to come from its position in the call's
 * write array, so a retried task whose write mix changed could put a new
 * channel on an index another channel already held. The first-write-wins
 * guard cannot tell a genuine retry from an unrelated write, so the new
 * channel was silently dropped while the shared one was persisted twice.
 */
describe('putWrites channel-keyed write rows (C3)', () => {
  /** A client where a repeat PutCommand on a committed sort key fails the guard. */
  function firstWriteWinsMock(): {
    client: CheckpointerContext['client'];
    committed: Set<string>;
  } {
    const { client, mock } = createStrictDocumentMock();
    const committed = new Set<string>();
    mock.on(PutCommand).callsFake((input: { Item: { SK: string } }) => {
      if (committed.has(input.Item.SK)) throw conditionalCheckFailed();
      committed.add(input.Item.SK);
      return {};
    });
    return { client, committed };
  }

  it('does not lose a new channel that lands on an index an earlier call used (C3)', async () => {
    // A retried task with a changed write mix: chanB now takes the array
    // position chanA held, so the positional index made chanB's Put collide
    // with chanA's committed row. The guard rejection was read as a benign
    // duplicate, so chanB was silently dropped while chanA was written twice.
    const { client, committed } = firstWriteWinsMock();
    const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };
    await putWrites(context(client), config, [['chanA', 'v']], 'task-1');
    await putWrites(
      context(client),
      config,
      [
        ['chanB', 'w'],
        ['chanA', 'v'],
      ],
      'task-1',
    );
    expect([...committed].sort()).toEqual([
      'WRITE##c1#task-1#0000000008#chanA',
      'WRITE##c1#task-1#0000000008#chanB',
    ]);
  });

  it('still treats a genuine retry of the same write set as a duplicate (C3)', async () => {
    const { client, committed } = firstWriteWinsMock();
    const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };
    const writes: [string, string][] = [
      ['chanA', 'v'],
      ['chanB', 'w'],
    ];
    await putWrites(context(client), config, [...writes], 'task-1');
    await expect(
      putWrites(context(client), config, [...writes], 'task-1'),
    ).resolves.toBeUndefined();
    expect(committed.size).toBe(2);
  });

  it('gives a channel repeated within one call successive rows in order (C3)', async () => {
    const { client, committed } = firstWriteWinsMock();
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['ch', 'first'],
        ['ch', 'second'],
      ],
      'task-1',
    );
    expect([...committed].sort()).toEqual([
      'WRITE##c1#task-1#0000000008#ch',
      'WRITE##c1#task-1#0000000009#ch',
    ]);
  });
});
