import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  fetchPayload,
  fetchPendingWrites,
  fetchTargetMeta,
} from '../../../../src/checkpointer/internal/read';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { LIST_SCAN_WARN_THRESHOLD } from '../../../../src/shared/dynamodb/paginate';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { threadAddress, writeItems } from '../../../shared/helpers/parsed-inputs';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

describe('fetchTargetMeta', () => {
  it('gets a specific checkpoint by id', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        PK: 'CHKPT#t',
        SK: 'META##c1',
        threadId: 't',
        checkpointId: 'c1',
        checkpointNs: '',
        metadata: {},
      },
    });
    const meta = await fetchTargetMeta(context(client), threadAddress('t', '', 'c1'));
    expect(meta?.checkpointId).toBe('c1');
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'CHKPT#t',
      SK: 'META##c1',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('queries the newest META item when no id is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CHKPT#t',
          SK: 'META##newest',
          threadId: 't',
          checkpointId: 'newest',
          checkpointNs: '',
          metadata: {},
        },
      ],
    });
    const meta = await fetchTargetMeta(context(client), threadAddress('t', ''));
    expect(meta?.checkpointId).toBe('newest');
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.Limit).toBeGreaterThan(1);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ConsistentRead).toBe(true);
  });

  it('returns undefined when the newest query is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    expect(await fetchTargetMeta(context(client), threadAddress('t', ''))).toBeUndefined();
  });
});

describe('fetchPayload', () => {
  it('gets the payload item by key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { SK: 'PAYLOAD##c1' } });
    const payload = await fetchPayload(context(client), {
      threadId: 't',
      checkpointNs: '',
      checkpointId: 'c1',
    });
    expect(payload?.SK).toBe('PAYLOAD##c1');
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('fetchPendingWrites', () => {
  it('paginates write items and decodes them in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const items = await writeItems(
      context(client),
      't',
      '',
      'c1',
      'task-1',
      [
        ['ch', 'v0'],
        ['ch', 'v1'],
      ],
      'nonce-1',
    );
    mock.on(QueryCommand).resolves({ Items: items });
    const pending = await fetchPendingWrites(context(client), {
      threadId: 't',
      checkpointNs: '',
      checkpointId: 'c1',
    });
    expect(pending).toEqual([
      ['task-1', 'ch', 'v0'],
      ['task-1', 'ch', 'v1'],
    ]);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('fetchPayload refuses a row a newer release wrote (C-03)', () => {
  const payloadItem = (v?: number) => ({
    SK: 'PAYLOAD##c1',
    ...(v === undefined ? {} : { v }),
    checkpoint: {
      location: 'INLINE',
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{}'),
    },
  });

  it('resolves a payload row carrying no v, and one at the supported version', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: payloadItem() });
    await expect(
      fetchPayload(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).resolves.toBeDefined();
    mock.on(GetCommand).resolves({ Item: payloadItem(1) });
    await expect(
      fetchPayload(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).resolves.toBeDefined();
  });

  it('rejects a payload row written by a newer release', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: payloadItem(2) });
    await expect(
      fetchPayload(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  it('still returns undefined for a missing payload row, before any version is checked', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(
      fetchPayload(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).resolves.toBeUndefined();
  });
});

describe('fetchPendingWrites refuses a row a newer release wrote (C-03)', () => {
  const writeItem = (channel: string, v?: number) => ({
    PK: 'CHKPT#t',
    SK: `WRITE##c1#task-1#0000000000#${channel}`,
    ...(v === undefined ? {} : { v }),
    taskId: 'task-1',
    index: 0,
    channel,
    writeGroup: 'g1',
    value: {
      location: 'INLINE',
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('"ok"'),
    },
  });

  it('resolves pending writes carrying no v, and ones at the supported version', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [writeItem('ch')] });
    await expect(
      fetchPendingWrites(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).resolves.toEqual([['task-1', 'ch', 'ok']]);
    mock.on(QueryCommand).resolves({ Items: [writeItem('ch', 1)] });
    await expect(
      fetchPendingWrites(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).resolves.toEqual([['task-1', 'ch', 'ok']]);
  });

  it('rejects a pending write above the supported version, even among readable ones', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [writeItem('ch1', 1), writeItem('ch2', 2)] });
    await expect(
      fetchPendingWrites(context(client), { threadId: 't', checkpointNs: '', checkpointId: 'c1' }),
    ).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });
});

describe('fetchTargetMeta head row narrowing (CKPT-08)', () => {
  const validMeta = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointId: 'c1',
    checkpointNs: '',
    metadata: {},
  };
  const foreignRow = { PK: 'CHKPT#t', SK: 'META##zzz', value: {} };

  it('skips a foreign newest row with a warning and returns the next real checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    let pages = 0;
    mock.on(QueryCommand).callsFake(() => {
      pages += 1;
      return pages === 1
        ? { Items: [foreignRow], LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'META##zzz' } }
        : { Items: [validMeta] };
    });
    const warn = jest.fn();
    const meta = await fetchTargetMeta(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      threadAddress('t', ''),
    );
    expect(meta?.checkpointId).toBe('c1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a checkpoint meta item'), {
      sortKey: 'META##zzz',
    });
  });

  it('returns undefined silently for an absent addressed row', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const warn = jest.fn();
    const meta = await fetchTargetMeta(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      threadAddress('t', '', 'c1'),
    );
    expect(meta).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined with a warning when the addressed row is not a checkpoint meta item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: foreignRow });
    const warn = jest.fn();
    const meta = await fetchTargetMeta(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      threadAddress('t', '', 'zzz'),
    );
    expect(meta).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPendingWrites on a very large fan-out (CKPT-04)', () => {
  it('reads past the in-memory cap and warns instead of failing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const total = LIST_SCAN_WARN_THRESHOLD + 1;
    const row = (index: number) => ({
      PK: 'CHKPT#t',
      SK: `WRITE##c1#task-1#${String(index + 8).padStart(10, '0')}#ch`,
      taskId: 'task-1',
      index,
      channel: 'ch',
      writeGroup: 'g1',
      occurrence: index,
      value: {
        location: 'INLINE',
        serdeType: 'json',
        compressed: false,
        bytes: new TextEncoder().encode('1'),
      },
    });
    const half = Math.floor(total / 2);
    mock.on(QueryCommand).callsFake((input) =>
      input.ExclusiveStartKey
        ? { Items: Array.from({ length: total - half }, (_, i) => row(half + i)) }
        : {
            Items: Array.from({ length: half }, (_, i) => row(i)),
            LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'x' },
          },
    );
    const warn = jest.fn();
    const pending = await fetchPendingWrites(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      { threadId: 't', checkpointNs: '', checkpointId: 'c1' },
    );
    expect(pending).toHaveLength(total);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pending-write'),
      expect.objectContaining({ rows: total }),
    );
  });
});

describe('fetchTargetMeta skips expired head rows (CKPT-10)', () => {
  const NOW = Math.floor(FROZEN_NOW_MS / 1000);
  const metaRow = (id: string, ttl: number) => ({
    PK: 'CHKPT#t',
    SK: `META##${id}`,
    threadId: 't',
    checkpointId: id,
    checkpointNs: '',
    metadata: {},
    ttl,
  });

  it('returns the newest live checkpoint when the head has expired but is not yet swept', async () => {
    const { client, mock } = createStrictDocumentMock();
    let pages = 0;
    mock.on(QueryCommand).callsFake(() => {
      pages += 1;
      return pages === 1
        ? { Items: [metaRow('c2', NOW - 1)], LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'META##c2' } }
        : { Items: [metaRow('c1', NOW + 60)] };
    });
    const meta = await fetchTargetMeta(context(client), threadAddress('t', ''));
    expect(meta?.checkpointId).toBe('c1');
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.FilterExpression).toContain('#ttl');
  });

  it('treats an addressed checkpoint past its ttl as absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: metaRow('c1', NOW - 1) });
    await expect(
      fetchTargetMeta(context(client), threadAddress('t', '', 'c1')),
    ).resolves.toBeUndefined();
  });
});
