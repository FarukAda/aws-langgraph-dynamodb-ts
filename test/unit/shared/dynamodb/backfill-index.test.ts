import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { backfillRecencyIndex } from '../../../../src/shared/dynamodb/backfill-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const meta = { PK: 'CHKPT#t1', SK: 'META##c1', checkpointId: 'c1' };
const payload = { PK: 'CHKPT#t1', SK: 'PAYLOAD##c1' };
const item = { PK: 'STORE#users', SK: 'u1#k', updatedAt: '2026-01-01T00:00:00.000Z' };
const session = {
  PK: 'HIST#s1',
  SK: 'HISTORY#SESSION',
  sessionId: 's1',
  updatedAt: '2026-02-02T00:00:00.000Z',
};
const message = { PK: 'HIST#s1', SK: 'MSG#01ABC' };

describe('backfillRecencyIndex', () => {
  it('writes index keys for the rows a listing reaches, and skips the rest', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [meta, payload, item, session, message] });
    mock.on(UpdateCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: 't' });
    expect(result).toMatchObject({ scanned: 5, indexed: 3, skipped: 2 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(3);
  });

  /**
   * A row a live adapter already indexed carries its true timestamp; replacing
   * it with the pre-index epoch would move a live row to the bottom of every
   * listing. The write is conditional so re-running is safe.
   */
  it('never overwrites keys a row already has', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [session] });
    mock.on(UpdateCommand).resolves({});
    await backfillRecencyIndex({ client, tableName: 't' });
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ConditionExpression).toBe('attribute_not_exists(#gpk)');
  });

  it('skips rows that already carry keys at the scan, not in memory', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await backfillRecencyIndex({ client, tableName: 't' });
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toBe(
      'attribute_not_exists(#gpk)',
    );
  });

  it('reports what it would do without writing, under dryRun', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [meta, item] });
    const result = await backfillRecencyIndex({ client, tableName: 't', dryRun: true });
    expect(result.indexed).toBe(2);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns a cursor at the page cap and resumes from it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolves({ Items: [session], LastEvaluatedKey: { PK: 'HIST#s1', SK: 'HISTORY#SESSION' } });
    mock.on(UpdateCommand).resolves({});
    const first = await backfillRecencyIndex({ client, tableName: 't', maxPages: 1 });
    expect(first.nextCursor).toBeDefined();
    await backfillRecencyIndex({ client, tableName: 't', maxPages: 1, cursor: first.nextCursor });
    const resumed = mock.commandCalls(ScanCommand).at(-1)?.args[0].input;
    expect(resumed?.ExclusiveStartKey).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
  });

  it('reads every page when no page cap is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [meta], LastEvaluatedKey: { PK: 'CHKPT#t1', SK: 'META##c1' } })
      .resolves({ Items: [session] });
    mock.on(UpdateCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: 't' });
    expect(result).toEqual({ scanned: 2, indexed: 2, skipped: 0 });
  });

  /** DynamoDB omits `Items` entirely for a page whose every row the filter dropped. */
  it('treats a page that returns no Items as an empty page', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: 't' });
    expect(result).toEqual({ scanned: 0, indexed: 0, skipped: 0 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('refuses a cursor it did not issue', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      backfillRecencyIndex({ client, tableName: 't', cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });

  it('refuses a non-positive page size', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      backfillRecencyIndex({ client, tableName: 't', pageSize: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });
});
