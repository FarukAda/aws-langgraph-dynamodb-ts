import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { assembleTuple } from '../../../../src/checkpointer/internal/assemble';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem } from '../../../../src/checkpointer/types';
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

const inline = (value: unknown) => ({
  location: 'INLINE',
  serdeType: 'json',
  schemaVersion: 1,
  compressed: false,
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

const checkpoint = {
  v: 4,
  id: 'c1',
  ts: '2026-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};

const meta = (over: Partial<CheckpointMetaItem> = {}): CheckpointMetaItem =>
  ({
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata: inline({ source: 'loop' }),
    ...over,
  }) as CheckpointMetaItem;

function withRows(
  items: { payload?: Record<string, unknown>; writes?: Record<string, unknown>[] } = {},
) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(GetCommand).resolves(items.payload === undefined ? {} : { Item: items.payload });
  mock.on(QueryCommand).resolves({ Items: items.writes ?? [] });
  return { client, mock };
}

const payloadRow = {
  PK: 'CHKPT#t',
  SK: 'PAYLOAD##c1',
  checkpoint: inline(checkpoint),
};

describe('assembleTuple', () => {
  it('builds the tuple from the payload, the metadata and the pending writes', async () => {
    const { client } = withRows({ payload: payloadRow });
    const tuple = await assembleTuple(context(client), 't', '', meta(), { consistent: true });
    expect(tuple?.config.configurable).toMatchObject({
      thread_id: 't',
      checkpoint_ns: '',
      checkpoint_id: 'c1',
    });
    expect(tuple?.checkpoint.id).toBe('c1');
    expect(tuple?.metadata).toEqual({ source: 'loop' });
    expect(tuple?.pendingWrites).toEqual([]);
  });

  /** The window the ordered PAYLOAD-then-META write leaves open. */
  it('answers undefined when the payload row is not there', async () => {
    const { client } = withRows({});
    await expect(
      assembleTuple(context(client), 't', '', meta(), { consistent: true }),
    ).resolves.toBeUndefined();
  });

  it('sets parentConfig only when the row names a parent', async () => {
    const { client } = withRows({ payload: payloadRow });
    const root = await assembleTuple(context(client), 't', '', meta(), { consistent: true });
    expect(root?.parentConfig).toBeUndefined();
    const child = await assembleTuple(
      context(client),
      't',
      '',
      meta({ parentCheckpointId: 'c0' }),
      { consistent: true },
    );
    expect(child?.parentConfig?.configurable).toMatchObject({ checkpoint_id: 'c0' });
  });

  /** A filtered list already decoded the metadata; decoding it twice costs a second download. */
  it('reuses metadata the caller already decoded instead of reading it again', async () => {
    const { client } = withRows({ payload: payloadRow });
    const tuple = await assembleTuple(
      context(client),
      't',
      '',
      meta({ metadata: undefined as never }),
      {
        consistent: true,
        metadata: { source: 'input' } as never,
      },
    );
    expect(tuple?.metadata).toEqual({ source: 'input' });
  });

  it('passes the consistency the caller asked for down to the payload read', async () => {
    const { client, mock } = withRows({ payload: payloadRow });
    await assembleTuple(context(client), 't', '', meta(), { consistent: false });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(false);
  });

  /**
   * The scope an offloaded payload is read under is the caller's thread, not
   * the row's, so a row cannot name an object outside the partition asked for.
   */
  it('scopes the payload decode to the caller s thread', async () => {
    const assertOwnedKey = jest.fn();
    const { client } = withRows({
      payload: {
        ...payloadRow,
        checkpoint: {
          location: 'S3',
          s3Key: 'ckpt/t/hash.bin',
          serdeType: 'json',
          schemaVersion: 1,
          compressed: false,
        },
      },
    });
    const offloader = {
      assertOwnedKey,
      download: () => new TextEncoder().encode(JSON.stringify(checkpoint)),
    };
    await assembleTuple(
      { ...context(client), offloader: offloader as never },
      'caller-thread',
      '',
      meta(),
      { consistent: true },
    );
    expect(assertOwnedKey).toHaveBeenCalledWith('ckpt/t/hash.bin', ['caller-thread']);
  });
});
