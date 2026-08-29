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
    // chanB gets a row of its own instead of being turned away by chanA's;
    // chanA lands at a second index, which the read side resolves (see
    // dropSupersededWrites) so it is never replayed twice.
    expect([...committed].sort()).toEqual([
      'WRITE##c1#task-1#0000000008#chanA',
      'WRITE##c1#task-1#0000000008#chanB',
      'WRITE##c1#task-1#0000000009#chanA',
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

  it('stamps successive calls with strictly increasing write groups (C3)', async () => {
    // dropSupersededWrites picks the *smallest* group for a (task, channel) to
    // find the earliest committed call, so the stamp must be time-ordered — a
    // random UUID would nonce correctly but leave that choice arbitrary.
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };
    await putWrites(context(client), config, [['ch', 'a']], 'task-1');
    await putWrites(context(client), config, [['ch', 'b']], 'task-2');
    const groups = mock
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item?.writeGroup as string);
    expect(groups).toHaveLength(2);
    expect(groups[0] < groups[1]).toBe(true);
  });

  it('asks DynamoDB for the rejecting row so a rejection can be diagnosed (C3, I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(mock.commandCalls(PutCommand)[0].args[0].input.ReturnValuesOnConditionCheckFailure).toBe(
      'ALL_OLD',
    );
  });

  it('logs a same-channel rejection at debug, as the duplicate it is (I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    // ALL_OLD attaches the existing item in raw AttributeValue form; the
    // document client does not unmarshall an error payload (verified against
    // real DynamoDB).
    mock
      .on(PutCommand)
      .rejects(Object.assign(conditionalCheckFailed(), { Item: { channel: { S: 'ch' } } }));
    const debug = jest.fn();
    const warn = jest.fn();
    await putWrites(
      { ...context(client), logger: { ...SILENT_LOGGER, debug, warn } },
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a rejection by an unexpected channel at warn (I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(PutCommand)
      .rejects(Object.assign(conditionalCheckFailed(), { Item: { channel: { S: 'other' } } }));
    const warn = jest.fn();
    await putWrites(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unexpected channel'),
      expect.objectContaining({ expected: 'ch', found: 'other' }),
    );
  });

  it('falls back to the duplicate reading when no attributes are returned (I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(conditionalCheckFailed());
    const debug = jest.fn();
    const warn = jest.fn();
    await putWrites(
      { ...context(client), logger: { ...SILENT_LOGGER, debug, warn } },
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
