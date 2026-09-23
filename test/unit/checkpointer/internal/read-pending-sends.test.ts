import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { type Checkpoint, TASKS } from '@langchain/langgraph-checkpoint';

import { migratePendingSends } from '../../../../src/checkpointer/internal/read';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  };
}

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  v: 1,
  id: 'c2',
  ts: '2026-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 3 },
  versions_seen: {},
  ...over,
});

const inline = (value: unknown) => ({
  location: 'INLINE',
  serdeType: 'json',
  schemaVersion: 1,
  compressed: false,
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

const sendRow = (channel: string, value: unknown) => ({
  PK: 'CHKPT#t',
  SK: `WRITE##c1#task-1#0000000000#${channel}`,
  taskId: 'task-1',
  channel,
  value: inline(value),
});

describe('migratePendingSends', () => {
  it('rebuilds TASKS from the parent s pending writes for a pre-v4 checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [sendRow(TASKS, { node: 'a' }), sendRow('other', 1)] });
    const migrated = await migratePendingSends(
      context(client),
      checkpoint(),
      { threadId: 't', checkpointNs: '', parentCheckpointId: 'c1' },
      {},
    );
    expect(migrated.channel_values[TASKS]).toEqual([{ node: 'a' }]);
    expect(migrated.channel_versions[TASKS]).toBe(3);
  });

  it('stamps the first version when the checkpoint carries none', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [sendRow(TASKS, { node: 'a' })] });
    const migrated = await migratePendingSends(
      context(client),
      checkpoint({ channel_versions: {} }),
      { threadId: 't', checkpointNs: '', parentCheckpointId: 'c1' },
      {},
    );
    expect(migrated.channel_versions[TASKS]).toBe(1);
  });

  /** v4 keeps its sends in the checkpoint, so there is nothing to migrate. */
  it('returns a v4 checkpoint untouched and reads nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const input = checkpoint({ v: 4 });
    await expect(
      migratePendingSends(
        context(client),
        input,
        { threadId: 't', checkpointNs: '', parentCheckpointId: 'c1' },
        {},
      ),
    ).resolves.toBe(input);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  /** Without a parent there is nowhere the sends could have been written. */
  it('returns a root checkpoint untouched and reads nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const input = checkpoint();
    await expect(
      migratePendingSends(
        context(client),
        input,
        { threadId: 't', checkpointNs: '', parentCheckpointId: undefined },
        {},
      ),
    ).resolves.toBe(input);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('does not mutate the checkpoint it was given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [sendRow(TASKS, { node: 'a' })] });
    const input = checkpoint();
    await migratePendingSends(
      context(client),
      input,
      { threadId: 't', checkpointNs: '', parentCheckpointId: 'c1' },
      {},
    );
    expect(input.channel_values[TASKS]).toBeUndefined();
  });

  it('rebuilds an empty TASKS channel when the parent holds no sends', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const migrated = await migratePendingSends(
      context(client),
      checkpoint(),
      { threadId: 't', checkpointNs: '', parentCheckpointId: 'c1' },
      {},
    );
    expect(migrated.channel_values[TASKS]).toEqual([]);
  });
});
