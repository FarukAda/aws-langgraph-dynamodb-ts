import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 2, parents: {} };

describe('getCheckpointTuple', () => {
  it('returns undefined when no checkpoint exists', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    expect(
      await getCheckpointTuple(context(client), { configurable: { thread_id: 't' } }),
    ).toBeUndefined();
  });

  it('assembles the full tuple (checkpoint, metadata, writes, parent) for the newest checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint,
      metadata,
      'parent-0',
    );
    const writeItems = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-1', [['messages', 'x']]);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: writeItems };
    });
    mock.on(GetCommand).resolves({ Item: payload });

    const tuple = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint).toEqual(checkpoint);
    expect(tuple?.metadata).toEqual(metadata);
    expect(tuple?.pendingWrites).toEqual([['task-1', 'messages', 'x']]);
    expect(tuple?.config.configurable?.checkpoint_id).toBe('ckpt-1');
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('parent-0');
  });

  it('omits parentConfig when the checkpoint has no parent', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await buildCheckpointItems(ctx, 't', '', checkpoint, metadata);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    const tuple = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(tuple?.parentConfig).toBeUndefined();
    expect(tuple?.pendingWrites).toEqual([]);
  });

  it('returns undefined when the payload item is missing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta } = await buildCheckpointItems(ctx, 't', '', checkpoint, metadata);
    mock.on(QueryCommand).resolves({ Items: [meta] });
    mock.on(GetCommand).resolves({});
    expect(await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } })).toBeUndefined();
  });
});
