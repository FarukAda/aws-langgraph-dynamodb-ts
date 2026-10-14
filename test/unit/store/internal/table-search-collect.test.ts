import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { parseNamespacePrefix, parseSearch } from '../../../../src/store/internal/parse';
import { buildStoreRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { collectCandidates } from '../../../../src/store/internal/table-search';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

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

const timestamps = { createdAt: 'c', updatedAt: 'u' };

/** `n` rows under `['docs']`, keyed `k00…`, each carrying one vector and its ordinal. */
async function rows(ctx: StoreContext, n: number) {
  return Promise.all(
    Array.from({ length: n }, (_unused, index) =>
      buildStoreRow(
        ctx,
        { namespace: ['docs'], key: `k${String(index).padStart(2, '0')}` },
        { n: index },
        { ...timestamps, embeddings: [[index, 1]] },
      ),
    ),
  );
}

const prefix = (labels: string[]) => parseNamespacePrefix(labels, 'namespacePrefix');

describe('collectCandidates', () => {
  it('collects a page in the order read, with the vectors each row carries, and stops once it is full', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock.on(QueryCommand).resolves({ Items: await rows(ctx, 5) });

    const page = await collectCandidates(ctx, parseSearch(prefix(['docs']), { limit: 2 }), {
      kind: 'page',
      need: 2,
    });

    expect(page.map((candidate) => candidate.item.key)).toEqual(['k00', 'k01']);
    expect(page.map((candidate) => candidate.embeddings)).toEqual([[[0, 1]], [[1, 1]]]);
  });

  /**
   * The rows are decoded a batch at a time, so a page can come back holding
   * more matches than it needs — the caller slices — but never one that
   * fails the filter, and never short while matching rows remain.
   */
  it('applies the filter after decoding, so a page is filled from matches only', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock.on(QueryCommand).resolves({ Items: await rows(ctx, 5) });

    const page = await collectCandidates(
      ctx,
      parseSearch(prefix(['docs']), { limit: 2, filter: { n: { $gte: 2 } } }),
      { kind: 'page', need: 2 },
    );

    expect(page.length).toBeGreaterThanOrEqual(2);
    expect(page.slice(0, 2).map((candidate) => candidate.item.key)).toEqual(['k02', 'k03']);
    expect(page.every((candidate) => (candidate.item.value as { n: number }).n >= 2)).toBe(true);
  });

  it('leaves out a row past its ttl and one outside the prefix', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const [live, expired, foreign] = await rows(ctx, 3);
    mock.on(QueryCommand).resolves({
      Items: [
        live,
        { ...expired, ttl: FROZEN_NOW_MS / 1000 - 1 },
        { ...foreign, namespace: ['other'], PK: 'STORE#other', SK: 'k02' },
      ],
    });

    const page = await collectCandidates(ctx, parseSearch(prefix(['docs']), { limit: 10 }), {
      kind: 'page',
      need: 10,
    });

    expect(page.map((candidate) => candidate.item.key)).toEqual(['k00']);
  });

  it('collects every candidate for a semantic ranking, and refuses more than the cap before decoding any', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const all = await rows(ctx, 4);
    mock.on(QueryCommand).resolves({ Items: all });

    const every = await collectCandidates(ctx, parseSearch(prefix(['docs']), { limit: 1 }), {
      kind: 'semantic',
      cap: 4,
    });
    expect(every).toHaveLength(4);

    await expect(
      collectCandidates(ctx, parseSearch(prefix(['docs']), { limit: 1 }), {
        kind: 'semantic',
        cap: 3,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxSearchCandidates' },
    });
  });

  it('scans the table for the empty prefix and queries one partition otherwise', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock.on(ScanCommand).resolves({ Items: await rows(ctx, 1) });
    mock.on(QueryCommand).resolves({ Items: [] });

    await collectCandidates(ctx, parseSearch(prefix([]), { limit: 1 }), { kind: 'page', need: 1 });
    await collectCandidates(ctx, parseSearch(prefix(['docs']), { limit: 1 }), {
      kind: 'page',
      need: 1,
    });

    expect(mock.commandCalls(ScanCommand)).toHaveLength(1);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(
      mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues,
    ).toMatchObject({ ':pk': 'STORE#docs' });
  });
});
