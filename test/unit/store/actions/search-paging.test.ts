import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import { searchItems } from '../../../../src/store/actions/search';
import { parseListOperation } from '../../../../src/store/internal/parse';
import { buildStoreRow, type StoreItemRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedSearch } from '../../../shared/helpers/parsed-inputs';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

/** A serde whose decode calls are counted, so a test can prove how many rows were decoded. */
function countingSerde() {
  const loads = jest.fn(JSON_SERDE.loadsTyped.bind(JSON_SERDE));
  return {
    serde: { dumpsTyped: JSON_SERDE.dumpsTyped.bind(JSON_SERDE), loadsTyped: loads },
    loads,
  };
}

async function rows(
  ctx: StoreContext,
  count: number,
  kindOf: (i: number) => string,
): Promise<StoreItemRow[]> {
  const out: StoreItemRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await buildStoreRow(
        ctx,
        { namespace: ['users', 'u1'], key: `k${i}` },
        { kind: kindOf(i), i },
        { createdAt: 'c', updatedAt: 'u', embeddings: [[1, 0]] },
      ),
    );
  }
  return out;
}

describe('plain search pages stop at offset + limit', () => {
  it('decodes only the requested page and never trips maxScanItems for a page that fits', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { serde, loads } = countingSerde();
    const ctx = context(client, { serde, maxScanItems: 2 });
    mock.on(QueryCommand).resolves({ Items: await rows(ctx, 3, () => 'note') });
    const items = await searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], limit: 1 }));
    expect(items.map((item) => item.key)).toEqual(['k0']);
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it('stops reading pages once enough filtered matches are collected', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const first = await rows(ctx, 8, (i) => (i % 2 === 1 ? 'note' : 'doc'));
    let pages = 0;
    mock.on(QueryCommand).callsFake(() => {
      pages += 1;
      return pages === 1
        ? { Items: first, LastEvaluatedKey: { PK: 'STORE#users', SK: 'x' } }
        : { Items: [] };
    });
    const items = await searchItems(
      ctx,
      parsedSearch({
        namespacePrefix: ['users'],
        filter: { kind: 'note' },
        limit: 1,
      }),
    );
    expect(items.map((item) => item.key)).toEqual(['k1']);
    expect(pages).toBe(1);
  });
});

describe('semantic search fails fast at the candidate cap', () => {
  it('rejects before decoding a row or embedding the query when the namespace exceeds maxSearchCandidates', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { serde, loads } = countingSerde();
    const embeddings = { embedQuery: jest.fn(() => [1, 0]), embedDocuments: jest.fn() };
    const ctx = context(client, {
      serde,
      maxSearchCandidates: 1,
      index: { dims: 2, embeddings: embeddings as never },
    });
    mock.on(QueryCommand).resolves({ Items: await rows(ctx, 3, () => 'note') });
    await expect(
      searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'hello' })),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxSearchCandidates' },
    });
    expect(loads).not.toHaveBeenCalled();
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });
});

describe('backend refill hitting the cap', () => {
  it('throws like the in-DB ranker instead of silently under-returning', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx0 = context(client);
    const records = await rows(ctx0, 8, (i) => (i === 0 ? 'note' : 'doc'));
    mock
      .on(GetCommand)
      .callsFake((input) => ({ Item: records.find((r) => r.SK === input.Key.SK) }));
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      /**
       * `VectorBackend.query` is typed `Promise<VectorMatch[]>`; this fake's
       * own computation is synchronous and never throws, so a non-async
       * function returning `Promise.resolve(...)` already has type
       * `Promise<VectorMatch[]>` and needs neither `async` nor `await`.
       */
      query: jest.fn((_ns: string[], _v: number[], topK: number) =>
        Promise.resolve(
          Array.from({ length: topK }, (_, i) => ({
            namespace: ['users', 'u1'],
            key: `k${i}`,
            score: 1 - i / 10,
          })),
        ),
      ),
    };
    const embeddings = { embedQuery: jest.fn(() => [1, 0]), embedDocuments: jest.fn() };
    const ctx = context(client, {
      maxSearchCandidates: 8,
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: backend,
    });
    await expect(
      searchItems(
        ctx,
        parsedSearch({
          namespacePrefix: ['users'],
          query: 'q',
          filter: { kind: 'note' },
          limit: 5,
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxSearchCandidates' },
    });
  });
});

describe('listNamespaces projects only the key attributes', () => {
  it('asks for PK, SK, namespace, key and the format version, not the payload', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    mock.on(QueryCommand).resolves({ Items: [] });
    await listNamespaces(context(client), parseListOperation({ limit: 10, offset: 0 }));
    const scan = mock.commandCalls(ScanCommand)[0].args[0].input;
    expect(scan.ProjectionExpression).toBe('PK, SK, #ns, #key, #v');
    expect(scan.ExpressionAttributeNames).toMatchObject({
      '#ns': 'namespace',
      '#key': 'key',
      '#v': 'v',
    });
    await listNamespaces(
      context(client),
      parseListOperation({
        limit: 10,
        offset: 0,
        matchConditions: [{ matchType: 'prefix', path: ['users'] }],
      }),
    );
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ProjectionExpression).toBe(
      'PK, SK, #ns, #key, #v',
    );
  });
});

describe('empty namespace on both paths', () => {
  it('returns nothing without decoding for a plain page and a semantic ranking alike', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const embeddings = { embedQuery: jest.fn(() => [1, 0]), embedDocuments: jest.fn() };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    await expect(searchItems(ctx, parsedSearch({ namespacePrefix: ['users'] }))).resolves.toEqual(
      [],
    );
    await expect(
      searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'q' })),
    ).resolves.toEqual([]);
  });
});

/**
 * `limit: 0` asks for an empty page, and the rule is that such a page is
 * answered without issuing a request. Both of these read one anyway:
 * `collectCandidates` pulls the first row from the paginator before it tests
 * its `offset + limit` bound, and a listing has to collect and sort every live
 * namespace before it can slice one off. The empty result was never in doubt —
 * what is asserted here is the request that is no longer paid for.
 */
describe('a page of zero costs no read', () => {
  it('answers search with nothing without a Query, a Scan or an embedding', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx0 = context(client);
    mock.on(QueryCommand).resolves({ Items: await rows(ctx0, 3, () => 'note') });
    const embeddings = { embedQuery: jest.fn(() => [1, 0]), embedDocuments: jest.fn() };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    await expect(
      searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], limit: 0 })),
    ).resolves.toEqual([]);
    await expect(
      searchItems(
        ctx,
        parsedSearch({ namespacePrefix: ['users'], query: 'q', limit: 0, offset: 2 }),
      ),
    ).resolves.toEqual([]);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it('answers listNamespaces with nothing without a Query or a Scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(
      listNamespaces(context(client), parseListOperation({ limit: 0, offset: 0 })),
    ).resolves.toEqual([]);
    await expect(
      listNamespaces(
        context(client),
        parseListOperation({
          limit: 0,
          offset: 0,
          matchConditions: [{ matchType: 'prefix', path: ['users'] }],
        }),
      ),
    ).resolves.toEqual([]);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});

describe('a filtered batch that leaves the page short keeps reading', () => {
  it('decodes the next batch when the first full batch produced fewer matches than the page needs', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock
      .on(QueryCommand)
      .resolves({ Items: await rows(ctx, 10, (i) => (i === 9 ? 'note' : 'doc')) });
    const items = await searchItems(
      ctx,
      parsedSearch({
        namespacePrefix: ['users'],
        filter: { kind: 'note' },
        limit: 1,
      }),
    );
    expect(items.map((item) => item.key)).toEqual(['k9']);
  });
});
