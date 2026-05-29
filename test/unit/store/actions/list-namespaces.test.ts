import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
  return { client, tableName: 'store', serde: JSON_SERDE, logger: SILENT_LOGGER };
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

  it('filters to store items and skips foreign rows on a shared table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [{ SK: 'META##c' }, { namespace: ['users', 'u1'] }] });
    const out = await listNamespaces(context(client), { limit: 100, offset: 0 });
    expect(out).toEqual([['users', 'u1']]);
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toBe(
      'attribute_exists(#ns)',
    );
  });
});
