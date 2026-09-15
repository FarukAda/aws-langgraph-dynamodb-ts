import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { queryRecencyIndex } from '../../../../src/shared/dynamodb/index-query';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function row(at: string, id: string) {
  return {
    PK: `SESS#${id}`,
    SK: 'SESSION',
    sessionId: id,
    gsi1pk: 'SESS#0',
    gsi1sk: `${at}#${id}`,
  };
}

function base(client: ReturnType<typeof createStrictDocumentMock>['client'], limit: number) {
  return {
    client,
    tableName: 'history',
    indexName: 'gsi1',
    tag: 'SESS' as const,
    shards: 2,
    limit,
  };
}

describe('queryRecencyIndex', () => {
  /**
   * Each shard is already sorted, so merging their pages and taking `limit`
   * is correct: no shard can contribute a row newer than the ones it returned.
   */
  it('merges every shard newest-first', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake((input) =>
        input.ExpressionAttributeValues[':pk'] === 'SESS#0'
          ? { Items: [row('2026-01-03T00:00:00Z', 'c'), row('2026-01-01T00:00:00Z', 'a')] }
          : { Items: [row('2026-01-02T00:00:00Z', 'b')] },
      );
    const page = await queryRecencyIndex(base(client, 3));
    expect(page.items.map((item) => item.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('queries every shard of the adapter', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await queryRecencyIndex(base(client, 5));
    const partitions = mock
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[':pk']);
    expect(partitions.sort()).toEqual(['SESS#0', 'SESS#1']);
  });

  it('hands back a cursor only when the page filled up', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('2026-01-01T00:00:00Z', 'a')] });
    /** Two shards each return one row, so a limit of 2 fills the page. */
    expect((await queryRecencyIndex(base(client, 2))).nextCursor).toBeDefined();
    /** A limit of 5 does not, which means every shard was exhausted. */
    expect((await queryRecencyIndex(base(client, 5))).nextCursor).toBeUndefined();
  });

  it('resumes below the cursor it issued', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('2026-01-05T00:00:00Z', 'e')] });
    const first = await queryRecencyIndex(base(client, 2));
    await queryRecencyIndex({ ...base(client, 2), cursor: first.nextCursor });
    const second = mock.commandCalls(QueryCommand).at(-1)?.args[0].input;
    expect(second?.KeyConditionExpression).toBe('#pk = :pk AND #sk < :before');
    expect(second?.ExpressionAttributeValues?.[':before']).toBe('2026-01-05T00:00:00Z#e');
  });

  it('reads the index newest-first, never the table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await queryRecencyIndex(base(client, 1));
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('gsi1');
    expect(input.ScanIndexForward).toBe(false);
  });

  it.each([0, -1, 1.5])('refuses a limit of %p', async (limit) => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex(base(client, limit))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  /** DynamoDB omits `Items` for a shard that holds nothing, rather than sending an empty list. */
  it('treats a shard that returns no Items as an empty shard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake((input) =>
        input.ExpressionAttributeValues[':pk'] === 'SESS#0'
          ? { Items: [row('2026-01-01T00:00:00Z', 'a')] }
          : {},
      );

    const page = await queryRecencyIndex(base(client, 10));

    expect(page.items.map((item) => item.sessionId)).toEqual(['a']);
  });

  /**
   * A `gsi1sk` is `<timestamp>#<id>`. A value carrying no `#` came from
   * somewhere else — a scan cursor, a token from another API — and using it as
   * a bound would quietly return the wrong page instead of saying so.
   */
  it.each([
    ['a scan cursor', Buffer.from('{"PK":"x"}', 'utf8').toString('base64url')],
    ['plain text', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['empty', ''],
  ])('refuses %s as a cursor', async (_name, cursor) => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex({ ...base(client, 10), cursor })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'cursor' },
    });
  });

  it('refuses a cursor it did not issue', async () => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex({ ...base(client, 2), cursor: '' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });
});
