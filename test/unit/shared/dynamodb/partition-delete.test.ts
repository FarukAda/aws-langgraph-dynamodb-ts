import {
  DeleteCommand,
  type DeleteCommandInput,
  type DynamoDBDocument,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import { beginsWithQuery, partitionQuery } from '../../../../src/checkpointer/internal/query';
import { sessionItemsQuery } from '../../../../src/history/internal/query';
import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import {
  deletePartitionRows,
  namedDescriptor,
  type NamedDescriptor,
  type PartitionDeleteOptions,
} from '../../../../src/shared/dynamodb/partition-delete';
import type { DocItem } from '../../../../src/shared/dynamodb/types';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { abortError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { conditionalTable } from '../../../shared/helpers/conditional-delete';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** Offloaded, so whether the pass releases a row's object is observable. */
function s3(s3Key: string, writeId?: string): PayloadDescriptor {
  return { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key, writeId };
}

const meta = (id: string, writeId?: string): DocItem => ({
  PK: 'CHKPT#t',
  SK: `META##${id}`,
  metadata: s3(`k-meta-${id}`, writeId),
});

const payload = (id: string, writeId?: string): DocItem => ({
  PK: 'CHKPT#t',
  SK: `PAYLOAD##${id}`,
  checkpoint: s3(`k-payload-${id}`, writeId),
});

const write = (id: string, writeGroup: string): DocItem => ({
  PK: 'CHKPT#t',
  SK: `WRITE##${id}#task#0000000008#ch`,
  writeGroup,
  value: s3(`k-write-${id}`, writeGroup),
});

/** Exactly what `deleteThread` supplies, down to the narrowing helper. */
function namedDescriptors(row: DocItem): NamedDescriptor[] {
  return (['metadata', 'checkpoint', 'value'] as const).flatMap((attribute) => {
    const entry = namedDescriptor(row, attribute);
    return entry === undefined ? [] : [entry];
  });
}

const fakeOffloader = (): { deleteBatch: jest.Mock; ownsKey: () => boolean } => ({
  deleteBatch: jest.fn().mockResolvedValue([]),
  ownsKey: () => true,
});

/** What `deleteThread` supplies: a pin attribute, the unit, and the kind boundary. */
function checkpointerOptions(
  client: DynamoDBDocument,
  extra: Partial<PartitionDeleteOptions> = {},
): PartitionDeleteOptions {
  return {
    client,
    tableName: 't',
    params: { TableName: 't' },
    logger: SILENT_LOGGER,
    operation: 'test.delete',
    ownsSortKey: (sortKey) => /^(META|PAYLOAD|WRITE)#/.test(sortKey),
    descriptorsOf: namedDescriptors,
    idAttribute: 'writeGroup',
    unitOf: (row) => (row.SK as string).split('#').slice(1, 3).join('#'),
    kindOf: (row) => (row.SK as string).split('#')[0],
    scope: ['t'],
    ...extra,
  };
}

/** What `clear` supplies: a pin attribute and nothing else — no unit, no boundary. */
function historyOptions(
  client: DynamoDBDocument,
  extra: Partial<PartitionDeleteOptions> = {},
): PartitionDeleteOptions {
  return {
    client,
    tableName: 't',
    params: { TableName: 't' },
    logger: SILENT_LOGGER,
    operation: 'test.clear',
    ownsSortKey: (sortKey) => sortKey.startsWith('HISTORY#'),
    descriptorsOf: (row) => {
      const entry = namedDescriptor(row, 'message');
      return entry === undefined ? [] : [entry];
    },
    idAttribute: 'writeId',
    scope: ['s'],
    ...extra,
  };
}

/** Run a pass whose query answers `observed` while the table holds `current`. */
function stage(
  observed: readonly DocItem[],
  current: readonly DocItem[] = observed,
): {
  client: DynamoDBDocument;
  mock: ReturnType<typeof createStrictDocumentMock>['mock'];
  table: ReturnType<typeof conditionalTable>;
} {
  const { client, mock } = createStrictDocumentMock();
  const table = conditionalTable(current);
  mock.on(QueryCommand).resolves({ Items: [...observed] });
  mock.on(DeleteCommand).callsFake(table.handler);
  return { client, mock, table };
}

/**
 * The narrowing every `descriptorsOf` goes through. A row this library did not
 * write can hold `null` where a descriptor belongs, and the type this fills
 * promises a descriptor, so the `null` has to stop here or be read for a write
 * id downstream.
 */
describe('namedDescriptor', () => {
  it('names the descriptor a row carries under the attribute', () => {
    expect(namedDescriptor(meta('c1', 'w1'), 'metadata')).toEqual({
      attribute: 'metadata',
      descriptor: s3('k-meta-c1', 'w1'),
    });
  });

  it('names nothing for an attribute the row omits or holds null in', () => {
    expect(namedDescriptor({ PK: 't', SK: 'META##c1' }, 'metadata')).toBeUndefined();
    expect(
      namedDescriptor({ PK: 't', SK: 'META##c1', metadata: null }, 'metadata'),
    ).toBeUndefined();
  });
});

describe('deletePartitionRows deletes what the read observed', () => {
  it('deletes every row whose observed id the row still carries', async () => {
    const rows = [meta('c1', 'w1'), payload('c1', 'w1'), write('c1', 'g1')];
    const { client, table } = stage(rows);
    const info = jest.fn();
    const deleted = await deletePartitionRows(
      checkpointerOptions(client, { logger: { ...SILENT_LOGGER, info } }),
    );
    expect(table.rows.size).toBe(0);
    expect(deleted).toBe(3);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('deleted rows'), {
      deleted: 3,
      skipped: 0,
    });
  });

  /** The erasure this closes: the row was rewritten between the read and the delete. */
  it('leaves a rewritten row in place, releases nothing for it, and reports it', async () => {
    const observed = [meta('c1', 'w1'), payload('c2', 'w1')];
    const current = [meta('c1', 'w2'), payload('c2', 'w1')];
    const { client, table } = stage(observed, current);
    const warn = jest.fn();
    const info = jest.fn();
    const offloader = fakeOffloader();
    await deletePartitionRows(
      checkpointerOptions(client, {
        logger: { ...SILENT_LOGGER, warn, info },
        offloader: offloader as never,
      }),
    );
    expect([...table.rows.keys()]).toEqual(['CHKPT#t|META##c1']);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-payload-c2']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rewritten'), {
      sortKey: 'META##c1',
    });
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 1, skipped: 1 });
  });

  /** No item on the rejection means the row is already gone: nothing is left to hold its object. */
  it('counts a row that is already gone as deleted and releases its object', async () => {
    const { client, table } = stage([meta('c1', 'w1')], []);
    const warn = jest.fn();
    const info = jest.fn();
    const offloader = fakeOffloader();
    await deletePartitionRows(
      checkpointerOptions(client, {
        logger: { ...SILENT_LOGGER, warn, info },
        offloader: offloader as never,
      }),
    );
    expect(table.rows.size).toBe(0);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-meta-c1']);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 1, skipped: 0 });
  });

  /**
   * A row written before the id existed carries none, and is deleted
   * unconditionally — otherwise a table upgraded in place could never be
   * emptied. Asserted by rewriting the row underneath the pass: it goes anyway.
   */
  it('deletes a row observed with no id at all, whatever the row holds now', async () => {
    const observed = [meta('c1')];
    const { client, mock, table } = stage(observed, [meta('c1', 'w9')]);
    await deletePartitionRows(checkpointerOptions(client));
    expect(table.rows.size).toBe(0);
    expect(mock.commandCalls(DeleteCommand)[0].args[0].input.ConditionExpression).toBeUndefined();
  });

  it('pins a WRITE row on its top-level write group rather than on its descriptor', async () => {
    const observed = [write('c1', 'g1')];
    const current = [{ ...write('c1', 'g1'), value: s3('k-write-c1', 'later') }];
    const { client, table } = stage(observed, current);
    await deletePartitionRows(checkpointerOptions(client));
    expect(table.rows.size).toBe(0);
  });
});

describe('deletePartitionRows carries a refusal forward', () => {
  const unitRows = [
    meta('c1', 'w1'),
    meta('c2', 'w1'),
    payload('c1', 'w1'),
    payload('c2', 'w1'),
    write('c1', 'g1'),
    write('c2', 'g2'),
  ];

  /**
   * The seam: the flush detects the refusal and the pass owns the set of
   * refused units. Both halves can pass their own tests while the composition
   * is inert, so this asserts the outcome — a refused META leaves its
   * checkpoint's later rows untouched, and no delete is issued for them.
   */
  it('skips a later row of a unit an earlier kind refused, and issues no delete for it', async () => {
    const current = unitRows.map((row) => (row.SK === 'META##c1' ? meta('c1', 'w2') : row));
    const { client, table } = stage(unitRows, current);
    const warn = jest.fn();
    const info = jest.fn();
    const offloader = fakeOffloader();
    await deletePartitionRows(
      checkpointerOptions(client, {
        logger: { ...SILENT_LOGGER, warn, info },
        offloader: offloader as never,
      }),
    );
    expect([...table.rows.keys()]).toEqual([
      'CHKPT#t|META##c1',
      'CHKPT#t|PAYLOAD##c1',
      'CHKPT#t|WRITE##c1#task#0000000008#ch',
    ]);
    expect(table.issued).not.toContain('PAYLOAD##c1');
    expect(table.issued).not.toContain('WRITE##c1#task#0000000008#ch');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unit'), {
      sortKey: 'PAYLOAD##c1',
    });
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 3, skipped: 3 });
    expect(offloader.deleteBatch).not.toHaveBeenCalledWith(expect.arrayContaining(['k-meta-c1']));
  });

  /**
   * The carry-forward is only correct because a kind's deletes are settled
   * before the next kind's are issued. One buffer of twenty-five spanning the
   * boundary would issue both at once and suppress nothing.
   */
  it("issues a kind's deletes together, in the order the scan returns them", async () => {
    /**
     * Deliberately weaker than the name this test used to carry. Issue order
     * cannot prove the kind-boundary flush: the deletes are started in index
     * order whether a boundary exists or not, so this assertion stays green
     * with the flush removed. What it pins is that the kinds are not
     * interleaved, which is the scan property the carry-forward relies on. The
     * boundary itself is proven by the suppression test above and by
     * `delete-thread`'s `table.issued` assertion, both of which go red without
     * it.
     */
    const { client, table } = stage(unitRows);
    await deletePartitionRows(checkpointerOptions(client));
    const kinds = table.issued.map((sortKey) => sortKey.split('#')[0]);
    expect(kinds).toEqual(['META', 'META', 'PAYLOAD', 'PAYLOAD', 'WRITE', 'WRITE']);
  });
  it('never lets one refusal stop the rows behind it', async () => {
    const observed = [meta('c1', 'w1'), meta('c2', 'w1'), meta('c3', 'w1')];
    const current = [meta('c1', 'w2'), meta('c2', 'w1'), meta('c3', 'w2')];
    const { client, table } = stage(observed, current);
    const info = jest.fn();
    await deletePartitionRows(checkpointerOptions(client, { logger: { ...SILENT_LOGGER, info } }));
    expect([...table.rows.keys()]).toEqual(['CHKPT#t|META##c1', 'CHKPT#t|META##c3']);
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 1, skipped: 2 });
  });

  /**
   * A history partition has no multi-row unit, so `clear` supplies neither a
   * unit nor a boundary and must behave exactly as it did before the feature:
   * a refused SESSION row stops no message row from being deleted.
   */
  it('carries nothing forward when the caller names no unit', async () => {
    const observed: DocItem[] = [
      { PK: 'HIST#s', SK: 'HISTORY#MSG#01A', message: s3('k-a', 'm1') },
      { PK: 'HIST#s', SK: 'HISTORY#SESSION', writeId: 'w1' },
    ];
    const current: DocItem[] = [observed[0], { ...observed[1], writeId: 'w2' }];
    const { client, table } = stage(observed, current);
    const warn = jest.fn();
    const info = jest.fn();
    await deletePartitionRows(historyOptions(client, { logger: { ...SILENT_LOGGER, warn, info } }));
    expect([...table.rows.keys()]).toEqual(['HIST#s|HISTORY#SESSION']);
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 1, skipped: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('deletePartitionRows reports a failure', () => {
  it('ends the pass with the rows that did persist, counted in rows', async () => {
    const observed = [meta('c1', 'w1'), meta('c2', 'w1')];
    const denied = Object.assign(new Error('no'), { name: 'AccessDeniedException' });
    const table = conditionalTable(observed);
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: observed });
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      if (input.Key?.SK === 'META##c2') throw denied;
      return table.handler(input);
    });
    await expect(deletePartitionRows(checkpointerOptions(client))).rejects.toMatchObject({
      code: ErrorCode.BATCH_WRITE_INCOMPLETE,
      details: { kind: 'pass', succeededCount: 1, failedChunks: [denied] },
    });
    expect(table.rows.size).toBe(1);
  });

  /**
   * A cancelled pass is a cancel, not a delete that half-landed: a caller
   * branching on `ABORTED` read a deliberate stop as a failed delete. The
   * request count is the half that is easy to fake — the PAYLOAD row belongs to
   * the next kind, so its delete is issued only if the pass carried on.
   */
  it('rethrows an abort from a row delete and issues no request after it', async () => {
    const observed = [meta('c1', 'w1'), payload('c1', 'w1')];
    const aborted = abortError();
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: observed });
    mock.on(DeleteCommand).rejectsOnce(aborted).resolves({});
    await expect(deletePartitionRows(checkpointerOptions(client))).rejects.toBe(aborted);
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

describe('the partition read this pass depends on', () => {
  /**
   * The carry-forward is correct only under an ascending scan: META sorts
   * before PAYLOAD before WRITE, which is what puts a refusal ahead of the rows
   * it suppresses. `beginsWithQuery` lives in the same module and defaults to
   * newest-first, so a reader has every reason to assume this one matches it.
   */
  it('scans ascending, which is what puts a refusal before the rows it suppresses', () => {
    expect(partitionQuery('t', 'CHKPT#t').ScanIndexForward).toBeUndefined();
    expect(sessionItemsQuery('t', 's').ScanIndexForward).toBeUndefined();
    expect(beginsWithQuery('t', 'CHKPT#t', 'META#').ScanIndexForward).toBe(false);
  });
});
