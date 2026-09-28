import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import { parseListOperation } from '../../../../src/store/internal/parse';
import { partitionKey, sortKey } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
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

/** A store row whose attributes agree with the DynamoDB key it lives at. */
const row = (namespace: string[], key = 'k') => ({
  PK: partitionKey(namespace),
  SK: sortKey(namespace, key),
  namespace,
  key,
});

const items = [
  row(['users', 'u1'], 'a'),
  row(['users', 'u1'], 'b'),
  row(['users', 'u2']),
  row(['orgs', 'o1']),
];

/**
 * A non-positive or non-integer `maxDepth` — Array.prototype.slice(0, -1)
 * drops the *last* element, so a negative one silently returned a
 * truncated-from-the-end namespace instead of erroring — is refused by the
 * parser before `listNamespaces` ever runs (see `parseListOperation` in
 * `test/unit/store/internal/parse.test.ts`); this action no longer checks its
 * input's shape.
 */
describe('listNamespaces', () => {
  it('returns distinct namespaces, sorted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(
      context(client),
      parseListOperation({ limit: 100, offset: 0 }),
    );
    expect(out).toEqual([
      ['orgs', 'o1'],
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
  });

  it('truncates to maxDepth and dedupes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(
      context(client),
      parseListOperation({ limit: 100, offset: 0, maxDepth: 1 }),
    );
    expect(out).toEqual([['orgs'], ['users']]);
  });

  it('does not collapse namespaces that differ only at an element boundary', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [row(['a b', 'c']), row(['a', 'b c'])],
    });
    const out = await listNamespaces(
      context(client),
      parseListOperation({ limit: 100, offset: 0 }),
    );
    expect(out).toHaveLength(2);
  });

  it('scopes to a Query and applies match conditions for a concrete prefix root', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: items });
    const out = await listNamespaces(
      context(client),
      parseListOperation({
        limit: 100,
        offset: 0,
        matchConditions: [{ matchType: 'prefix', path: ['users'] }],
      }),
    );
    expect(out).toEqual([
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
    expect(
      mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ':pk': 'STORE#users',
    });
  });

  it('falls back to a Scan when a prefix condition starts with a wildcard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(
      context(client),
      parseListOperation({
        limit: 100,
        offset: 0,
        matchConditions: [{ matchType: 'prefix', path: ['*', 'u1'] }],
      }),
    );
    expect(out).toEqual([['users', 'u1']]);
  });

  /**
   * Collation calls these two distinct namespaces equal, so without a
   * tie-break their order — and with it every page boundary — is decided by
   * whichever order DynamoDB returned the rows in.
   */
  it('orders namespaces the collation calls equal by a stable tie-break', async () => {
    const precomposed = ['café'];
    const decomposed = ['café'];
    expect(precomposed[0].localeCompare(decomposed[0])).toBe(0);
    const page = async (rows: ReturnType<typeof row>[]): Promise<string[][]> => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(ScanCommand).resolves({ Items: rows });
      return listNamespaces(context(client), parseListOperation({ limit: 1, offset: 0 }));
    };
    const forwards = await page([row(precomposed), row(decomposed)]);
    const backwards = await page([row(decomposed), row(precomposed)]);
    expect(forwards).toEqual(backwards);
  });

  it('applies offset and limit', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), parseListOperation({ limit: 1, offset: 1 }));
    expect(out).toEqual([['users', 'u1']]);
  });

  it('filters to store items and skips foreign rows on a shared table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [{ SK: 'META##c' }, row(['users', 'u1'])] });
    const out = await listNamespaces(
      context(client),
      parseListOperation({ limit: 100, offset: 0 }),
    );
    expect(out).toEqual([['users', 'u1']]);
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toContain(
      'attribute_exists(#ns)',
    );
  });

  it('honors a lowered maxScanItems instead of falling back to the unconfigurable default', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const ctx = { ...context(client), maxScanItems: 3 };
    // 4 items under a 3-item cap must throw `RESULT_TRUNCATED`, proving the
    // configured cap (not the old unconfigurable 10,000 default) is in effect.
    await expect(
      listNamespaces(ctx, parseListOperation({ limit: 100, offset: 0 })),
    ).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
  });
});
