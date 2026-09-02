import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  fetchPayload,
  fetchPendingWrites,
  fetchTargetMeta,
} from '../../../../src/checkpointer/internal/fetch';
import { buildWriteItems } from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { LIST_SCAN_WARN_THRESHOLD } from '../../../../src/shared/constants';
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

describe('fetchTargetMeta', () => {
  it('gets a specific checkpoint by id', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { checkpointId: 'c1', checkpointNs: '', metadata: {} } });
    const meta = await fetchTargetMeta(context(client), 't', '', 'c1');
    expect(meta?.checkpointId).toBe('c1');
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'CHKPT#t',
      SK: 'META##c1',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('queries the newest META item when no id is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .resolves({ Items: [{ checkpointId: 'newest', checkpointNs: '', metadata: {} }] });
    const meta = await fetchTargetMeta(context(client), 't', '');
    expect(meta?.checkpointId).toBe('newest');
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.Limit).toBe(1);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ConsistentRead).toBe(true);
  });

  it('returns undefined when the newest query is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    expect(await fetchTargetMeta(context(client), 't', '')).toBeUndefined();
  });
});

describe('fetchPayload', () => {
  it('gets the payload item by key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { SK: 'PAYLOAD##c1' } });
    const payload = await fetchPayload(context(client), 't', '', 'c1');
    expect(payload?.SK).toBe('PAYLOAD##c1');
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('fetchPendingWrites', () => {
  it('paginates write items and decodes them in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const items = await buildWriteItems(
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
    const pending = await fetchPendingWrites(context(client), 't', '', 'c1');
    expect(pending).toEqual([
      ['task-1', 'ch', 'v0'],
      ['task-1', 'ch', 'v1'],
    ]);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('fetchTargetMeta head row narrowing (CKPT-08)', () => {
  const validMeta = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
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
      't',
      '',
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
      't',
      '',
      'c1',
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
      't',
      '',
      'zzz',
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
      't',
      '',
      'c1',
    );
    expect(pending).toHaveLength(total);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pending-write'),
      expect.objectContaining({ rows: total }),
    );
  });
});
