import {
  GetCommand,
  type NativeAttributeValue,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { addMessages } from '../../../../src/history/actions/add-messages';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import type { PayloadDescriptor } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedPut } from '../../../shared/helpers/parsed-inputs';

type Row = Record<string, NativeAttributeValue> | undefined;

/** The id stored inside one of a row's descriptor attributes. */
function writeIdOn(row: Row, attribute: string): string | undefined {
  return (row as Record<string, PayloadDescriptor>)[attribute].writeId;
}

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

function checkpointerContext(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

function historyContext(client: HistoryContext['client']): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U0',
    onCorruptMessage: 'skip',
  };
}

function storeContext(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
  };
}

/**
 * Every adapter encodes through one function, so an id set there reaches every
 * row this library writes. These are the call sites that go through it, driven
 * from their public actions so a site added without the id would be visible
 * here rather than inferred from the shared helper.
 */
describe('every row a write leaves carries that write id inside its descriptor', () => {
  it('stamps one id on both rows a checkpoint put writes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await putCheckpoint(
      checkpointerContext(client),
      { configurable: { thread_id: 't1' } },
      checkpoint,
      metadata,
    );
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const meta = writeIdOn(items[0].Put?.Item, 'metadata');
    const payload = writeIdOn(items[1].Put?.Item, 'checkpoint');
    expect(meta).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/));
    expect(payload).toBe(meta);
  });

  it('draws a fresh id for a second put of the same checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const context = checkpointerContext(client);
    const config = { configurable: { thread_id: 't1' } };
    await putCheckpoint(context, config, checkpoint, metadata);
    await putCheckpoint(context, config, checkpoint, metadata);
    const idOf = (call: number): string | undefined =>
      writeIdOn(
        mock.commandCalls(TransactWriteCommand)[call].args[0].input.TransactItems?.[0].Put?.Item,
        'metadata',
      );
    expect(idOf(0)).not.toBe(idOf(1));
  });

  it('stamps the write group a putWrites call shares on every row it writes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putWrites(
      checkpointerContext(client),
      { configurable: { thread_id: 't1', checkpoint_id: 'ckpt-1' } },
      [
        ['messages', { text: 'a' }],
        ['other', { text: 'b' }],
      ],
      'task-1',
    );
    const rows = mock.commandCalls(PutCommand).map((call) => call.args[0].input.Item);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(writeIdOn(row, 'value')).toBe(row?.writeGroup);
  });

  it('stamps the revision a store row carries', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putItem(
      storeContext(client),
      parsedPut({ namespace: ['users', 'u1'], key: 'profile', value: { name: 'a' } }),
    );
    const row = mock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(writeIdOn(row, 'value')).toBe(row?.rev);
  });

  it('stamps the id an appended message is sorted by', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(historyContext(client), 's1', [new HumanMessage('a')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[1].Put?.Item?.SK).toBe('HISTORY#MSG#U0');
    expect(writeIdOn(items[1].Put?.Item, 'message')).toBe('U0');
  });
});
