import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
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
      'nonce-1',
      'parent-0',
    );
    const writeItems = await buildWriteItems(
      ctx,
      't',
      '',
      'ckpt-1',
      'task-1',
      [['messages', 'x']],
      'nonce-1',
    );
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
    const { meta, payload } = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint,
      metadata,
      'nonce-1',
    );
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
    const { meta } = await buildCheckpointItems(ctx, 't', '', checkpoint, metadata, 'nonce-1');
    mock.on(QueryCommand).resolves({ Items: [meta] });
    mock.on(GetCommand).resolves({});
    expect(await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } })).toBeUndefined();
  });
});

describe('getCheckpointTuple S3 key binding (SEC-03)', () => {
  it("refuses to download a checkpoint payload whose key lies outside the thread's path", async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = {
      download: jest.fn(),
      assertOwnedKey: (key: string, scope: readonly string[]) => assertKeyInScope(key, 'p/', scope),
    };
    const ctx = { ...context(client), offloader: offloader as never };
    const meta = {
      PK: 'CHKPT#t',
      SK: 'META##ckpt-1',
      threadId: 't',
      checkpointNs: '',
      checkpointId: 'ckpt-1',
      metadata: {
        location: PayloadLocation.INLINE,
        serdeType: 'json',
        compressed: false,
        bytes: new TextEncoder().encode('{}'),
      },
    };
    const payload = {
      PK: 'CHKPT#t',
      SK: 'PAYLOAD##ckpt-1',
      checkpoint: {
        location: PayloadLocation.S3,
        serdeType: 'json',
        compressed: false,
        s3Key: buildS3Key('p/', ['victim', '', 'ckpt-1', 'checkpoint', 'n']),
      },
    };
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3Key' },
    });
    expect(offloader.download).not.toHaveBeenCalled();
  });
});

describe('getCheckpointTuple with a foreign head row (CKPT-08)', () => {
  it('falls back to the newest real checkpoint instead of reporting an empty thread', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = { ...context(client), logger: { ...SILENT_LOGGER, warn } };
    const { meta, payload } = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint,
      metadata,
      'nonce-1',
    );
    let metaPages = 0;
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (!prefix.startsWith('META')) return { Items: [] };
      metaPages += 1;
      return metaPages === 1
        ? {
            Items: [{ PK: 'CHKPT#t', SK: 'META##zzz', value: {} }],
            LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'META##zzz' },
          }
        : { Items: [meta] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    const tuple = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint.id).toBe('ckpt-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getCheckpointTuple reads strongly consistently (CKPT-07)', () => {
  it('sets ConsistentRead on the payload get and the writes query', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint,
      metadata,
      'nonce-1',
    );
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
    const writesQuery = mock
      .commandCalls(QueryCommand)
      .find((c) =>
        (c.args[0].input.ExpressionAttributeValues?.[':skPrefix'] as string).startsWith('WRITE'),
      );
    expect(writesQuery?.args[0].input.ConsistentRead).toBe(true);
  });
});
