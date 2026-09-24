import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { buildS3Key, assertKeyInScope } from '../../../../src/shared/codec/s3/config';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { checkpointItems, writeItems } from '../../../shared/helpers/parsed-inputs';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
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
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata, 'parent-0');
    const writeRows = await writeItems(
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
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: writeRows };
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
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
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
    const { meta } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
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
        s3Key: buildS3Key(
          'p/',
          ['victim', '', 'ckpt-1', 'checkpoint'],
          '01J9ZQ5X3N8VQ4M6C2T7R0K1HD',
        ),
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
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
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
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
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

describe('getCheckpointTuple validation-suite behaviours', () => {
  it('returns undefined without touching DynamoDB when the config names no thread', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(
      getCheckpointTuple(context(client), { configurable: { checkpoint_ns: '' } }),
    ).resolves.toBeUndefined();
    await expect(getCheckpointTuple(context(client), {})).resolves.toBeUndefined();
    expect(mock.calls()).toHaveLength(0);
  });

  it("rebuilds a pre-v4 checkpoint's pending sends from its parent's __pregel_tasks writes", async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const legacy: Checkpoint = {
      ...checkpoint,
      v: 1,
      id: 'c1',
      channel_values: {},
      channel_versions: {},
    };
    const { meta, payload } = await checkpointItems(ctx, 't', '', legacy, metadata, 'c0');
    const parentWrites = [
      ...(await writeItems(
        ctx,
        't',
        '',
        'c0',
        'task-1',
        [
          ['__pregel_tasks', 'send-1'],
          ['__pregel_tasks', 'send-2'],
        ],
        'g1',
      )),
      ...(await writeItems(
        ctx,
        't',
        '',
        'c0',
        'task-2',
        [
          ['__pregel_tasks', 'send-3'],
          ['other', 'x'],
        ],
        'g2',
      )),
    ];
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (prefix.startsWith('META')) return { Items: [meta] };
      return { Items: prefix.includes('#c0#') ? parentWrites : [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    const tuple = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint.channel_values).toEqual({
      __pregel_tasks: ['send-1', 'send-2', 'send-3'],
    });
    expect(tuple?.checkpoint.channel_versions.__pregel_tasks).toBe(1);
  });

  it('stamps the migrated sends channel with the highest existing version and leaves a v4 or root checkpoint alone', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const legacy: Checkpoint = {
      ...checkpoint,
      v: 3,
      id: 'c1',
      channel_values: {},
      channel_versions: { a: 2, b: 5 },
    };
    const child = await checkpointItems(ctx, 't', '', legacy, metadata, 'c0');
    const root = await checkpointItems(ctx, 't', '', { ...legacy, id: 'c0' }, metadata);
    let head = child;
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [head.meta] } : { Items: [] };
    });
    mock.on(GetCommand).callsFake(() => ({ Item: head.payload }));
    const migrated = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(migrated?.checkpoint.channel_values).toEqual({ __pregel_tasks: [] });
    expect(migrated?.checkpoint.channel_versions.__pregel_tasks).toBe(5);
    head = root;
    const untouched = await getCheckpointTuple(ctx, { configurable: { thread_id: 't' } });
    expect(untouched?.checkpoint.channel_values).toEqual({});
  });
});

/**
 * A config naming no thread is answered with "nothing", but the identifiers it
 * *does* give are still checked — which is what the reference saver does
 * (@langchain/langgraph-checkpoint@1.1.5 dist/memory.js:86-92, where
 * `checkpoint_ns` is asserted whether or not a thread id is present), and what
 * `list()` on the same config already did.
 */
describe('getTuple on a config that names no thread', () => {
  it('returns undefined for an otherwise valid config', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      getCheckpointTuple(context(client), { configurable: {} }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a malformed checkpoint_ns', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      getCheckpointTuple(context(client), { configurable: { checkpoint_ns: 'a#b' } }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'checkpoint_ns' } });
  });

  it('still rejects a malformed checkpoint_id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      getCheckpointTuple(context(client), { configurable: { checkpoint_id: 'a#b' } }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'checkpoint_id' } });
  });
});

/**
 * The META check alone let a checkpoint back out with a PAYLOAD or a pending
 * write a newer release had written, silently missing whatever that release
 * changed (C-03). These pin the check on both other row kinds and confirm the
 * META check itself is unaffected.
 */
describe('getCheckpointTuple refuses a PAYLOAD or WRITE row a newer release wrote (C-03)', () => {
  it("rejects a PAYLOAD row above this release's format version, even though its META is readable", async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: { ...payload, v: 2 } });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).rejects.toMatchObject({ code: ErrorCode.FORMAT_UNSUPPORTED, context: { field: 'v' } });
  });

  it('resolves when the PAYLOAD row carries the supported version, and when it carries none', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).resolves.toBeDefined();
    const { v: _v, ...withoutV } = payload;
    mock.on(GetCommand).resolves({ Item: withoutV });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).resolves.toBeDefined();
  });

  it("rejects a WRITE row above this release's format version, among otherwise readable pending writes", async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
    const writeRows = await writeItems(
      ctx,
      't',
      '',
      'ckpt-1',
      'task-1',
      [
        ['messages', 'x'],
        ['messages', 'y'],
      ],
      'nonce-1',
    );
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (prefix.startsWith('META')) return { Items: [meta] };
      return { Items: [writeRows[0], { ...writeRows[1], v: 2 }] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).rejects.toMatchObject({ code: ErrorCode.FORMAT_UNSUPPORTED, context: { field: 'v' } });
  });

  it('a META row above the format version still rejects, whatever version its PAYLOAD carries (control)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { meta, payload } = await checkpointItems(ctx, 't', '', checkpoint, metadata);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [{ ...meta, v: 2 }] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: payload });
    await expect(
      getCheckpointTuple(ctx, { configurable: { thread_id: 't' } }),
    ).rejects.toMatchObject({ code: ErrorCode.FORMAT_UNSUPPORTED, context: { field: 'v' } });
  });
});
