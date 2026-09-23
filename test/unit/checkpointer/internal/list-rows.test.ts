import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { metaRows, narrowOrWarn } from '../../../../src/checkpointer/internal/list-rows';
import { type ListScope, parseListScope } from '../../../../src/checkpointer/internal/parse';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { MAX_LOGGED_VALUE_CHARS, MAX_SORT_KEY_BYTES } from '../../../../src/shared/constants';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(
  client: CheckpointerContext['client'],
  extra?: Partial<CheckpointerContext>,
): CheckpointerContext {
  return {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ...extra,
  };
}

/** A `ListScope` built through the real parser: thread `t`, the root namespace, no bound. */
function scope(over: { threadId?: string } = {}): ListScope {
  return parseListScope({
    configurable: { thread_id: over.threadId ?? 't', checkpoint_ns: '' },
  });
}

const row = (id: string) => ({
  PK: 'CHKPT#t',
  SK: `META##${id}`,
  threadId: 't',
  checkpointNs: '',
  checkpointId: id,
  metadata: { location: 'INLINE' },
});

async function collect(source: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('metaRows', () => {
  it('queries the thread s partition when the scope names a thread', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('c1')] });
    const rows = await collect(metaRows(context(client), scope(), 1_000));
    expect(rows).toHaveLength(1);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  /** No thread means every thread, which without the recency index is a table scan. */
  it('scans the table when the scope names no thread and there is no index', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [row('c1')] });
    const rows = await collect(
      metaRows(context(client), parseListScope({ configurable: {} }), 1_000),
    );
    expect(rows).toHaveLength(1);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('reads the recency index instead when the table has one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const rows = await collect(
      metaRows(context(client, { indexName: 'gsi1' }), parseListScope({ configurable: {} }), 1_000),
    );
    expect(rows).toEqual([]);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.IndexName).toBe('gsi1');
  });

  /** The stream must not accumulate: abandoning it stops the read. */
  it('stops reading when the consumer stops consuming', async () => {
    const { client, mock } = createStrictDocumentMock();
    let pages = 0;
    mock.on(QueryCommand).callsFake(() => {
      pages += 1;
      return { Items: [row(`c${pages}`)], LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'x' } };
    });
    for await (const _ of metaRows(context(client), scope(), 1_000)) break;
    expect(pages).toBe(1);
  });
});

describe('narrowOrWarn', () => {
  it('returns the item for a row this adapter wrote', () => {
    expect(narrowOrWarn(context({} as never), row('c1'))?.checkpointId).toBe('c1');
  });

  /** A foreign row sharing the META# prefix is skipped, and an operator is told it is there. */
  it('skips a foreign row and reports its sort key', () => {
    const warn = jest.fn();
    const ctx = context({} as never, { logger: { ...SILENT_LOGGER, warn } });
    expect(narrowOrWarn(ctx, { PK: 'CHKPT#t', SK: 'META##zzz', value: {} })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a checkpoint meta item'), {
      sortKey: 'META##zzz',
    });
  });

  /**
   * These warnings fire once per row, and a listing walks up to ten thousand,
   * so a foreign partition of long sort keys turned one `list` into megabytes
   * of log. The line still identifies the row; the rest is in the row.
   */
  it('bounds the sort key it reports', () => {
    const warn = jest.fn();
    const ctx = context({} as never, { logger: { ...SILENT_LOGGER, warn } });
    const sortKey = `META##${'z'.repeat(MAX_SORT_KEY_BYTES)}`;
    expect(narrowOrWarn(ctx, { PK: 'CHKPT#t', SK: sortKey, value: {} })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sortKey: truncateForLog(sortKey),
    });
    const reported = (warn.mock.calls[0][1] as { sortKey: string }).sortKey;
    expect(reported.startsWith('META##')).toBe(true);
    expect(reported.length).toBeLessThan(MAX_LOGGED_VALUE_CHARS + 20);
  });

  /** A row of ours from a newer release fails loudly rather than shortening the thread. */
  it('throws for a row of this adapter written by a newer format version', () => {
    expect(() => narrowOrWarn(context({} as never), { ...row('c1'), v: 99 })).toThrow(
      /format version 99/,
    );
  });
});
