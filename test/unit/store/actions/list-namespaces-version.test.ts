import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import { partitionKey, sortKey } from '../../../../src/store/internal/keys';
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
    vectorScoreDirection: 'relevance',
  };
}

type Row = Record<string, unknown>;

/** A store row whose attributes agree with the DynamoDB key it lives at. */
const row = (namespace: string[], extra: Row = {}): Row => ({
  PK: partitionKey(namespace),
  SK: sortKey(namespace, 'k'),
  namespace,
  key: 'k',
  value: { location: 'INLINE', serdeType: 'json', schemaVersion: 1, compressed: false },
  ...extra,
});

/**
 * What DynamoDB returns for `items` under the request's projection: only the
 * attributes it names. A listing that leaves `v` out of its projection never
 * sees a row's version, however the row was written — which is the defect a
 * mock returning whole rows would hide.
 */
function projected(
  input: { ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> },
  items: Row[],
): Row[] {
  if (input.ProjectionExpression === undefined) return items;
  const names = input.ProjectionExpression.split(',').map((path) => {
    const token = path.trim();
    return input.ExpressionAttributeNames?.[token] ?? token;
  });
  return items.map((item) =>
    Object.fromEntries(names.filter((name) => name in item).map((name) => [name, item[name]])),
  );
}

/** Answer the listing's read, whichever command it sends, as DynamoDB would. */
function serve(mock: ReturnType<typeof createStrictDocumentMock>['mock'], items: Row[]) {
  mock.on(ScanCommand).callsFake((input) => ({ Items: projected(input, items) }));
  mock.on(QueryCommand).callsFake((input) => ({ Items: projected(input, items) }));
}

/**
 * A store row a newer release wrote may have changed what `namespace` means,
 * and a namespace listing returns that attribute to the caller. The listing
 * narrows every row through the check `store.get` and `store.search` use, so
 * it refuses such a row too — which it can only do if the row's version is
 * among the attributes it reads.
 */
describe.each([
  ['a scan, with no prefix root', {}],
  ['a query, under a prefix root', { prefix: ['users'] }],
])('listNamespaces through %s', (_path, scope) => {
  it('refuses a store row written in a newer format version', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [row(['users', 'a']), row(['users', 'b'], { v: 2 })]);

    await expect(
      listNamespaces(context(client), { limit: 10, offset: 0, ...scope }),
    ).rejects.toMatchObject({ code: ErrorCode.FORMAT_UNSUPPORTED, context: { field: 'v' } });
  });

  it('lists a row at the current version and a row written before the attribute', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [row(['users', 'a'], { v: 1 }), row(['users', 'b'])]);

    const namespaces = await listNamespaces(context(client), { limit: 10, offset: 0, ...scope });

    expect(namespaces).toEqual([
      ['users', 'a'],
      ['users', 'b'],
    ]);
  });

  /** A row that is not a store item is not this adapter's to version: skipped, never refused. */
  it('still skips a foreign row that carries a high v', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [{ PK: 'STORE#users', SK: 'other', v: 9 }, row(['users', 'a'])]);

    const namespaces = await listNamespaces(context(client), { limit: 10, offset: 0, ...scope });

    expect(namespaces).toEqual([['users', 'a']]);
  });
});
