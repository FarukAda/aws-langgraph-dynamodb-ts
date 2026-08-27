import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { ValidationError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
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
  };
}

const items = [
  { namespace: ['users', 'u1'] },
  { namespace: ['users', 'u1'] },
  { namespace: ['users', 'u2'] },
  { namespace: ['orgs', 'o1'] },
];

describe('listNamespaces', () => {
  it('returns distinct namespaces, sorted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), { limit: 100, offset: 0 });
    expect(out).toEqual([
      ['orgs', 'o1'],
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
  });

  it('truncates to maxDepth and dedupes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), { limit: 100, offset: 0, maxDepth: 1 });
    expect(out).toEqual([['orgs'], ['users']]);
  });

  it('does not collapse namespaces that differ only at an element boundary', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [{ namespace: ['a b', 'c'] }, { namespace: ['a', 'b c'] }],
    });
    const out = await listNamespaces(context(client), { limit: 100, offset: 0 });
    expect(out).toHaveLength(2);
  });

  it('scopes to a Query and applies match conditions for a concrete prefix root', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), {
      limit: 100,
      offset: 0,
      matchConditions: [{ matchType: 'prefix', path: ['users'] }],
    });
    expect(out).toEqual([
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'users',
    });
  });

  it('falls back to a Scan when a prefix condition starts with a wildcard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), {
      limit: 100,
      offset: 0,
      matchConditions: [{ matchType: 'prefix', path: ['*', 'u1'] }],
    });
    expect(out).toEqual([['users', 'u1']]);
  });

  it('applies offset and limit', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const out = await listNamespaces(context(client), { limit: 1, offset: 1 });
    expect(out).toEqual([['users', 'u1']]);
  });

  it('throws ValidationError on a negative offset', async () => {
    const { client } = createStrictDocumentMock();
    await expect(listNamespaces(context(client), { limit: 10, offset: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError on a non-integer limit', async () => {
    const { client } = createStrictDocumentMock();
    await expect(listNamespaces(context(client), { limit: 1.5, offset: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('filters to store items and skips foreign rows on a shared table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [{ SK: 'META##c' }, { namespace: ['users', 'u1'] }] });
    const out = await listNamespaces(context(client), { limit: 100, offset: 0 });
    expect(out).toEqual([['users', 'u1']]);
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toBe(
      'attribute_exists(#ns)',
    );
  });

  it('honors a lowered maxScanItems instead of falling back to the unconfigurable default', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    const ctx = { ...context(client), maxScanItems: 3 };
    // 4 items under a 3-item cap must throw ResultTruncatedError, proving the
    // configured cap (not the old unconfigurable 10,000 default) is in effect.
    await expect(listNamespaces(ctx, { limit: 100, offset: 0 })).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
  });
});
