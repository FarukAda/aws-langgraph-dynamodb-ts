import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { MAX_LOGGED_LABELS, MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
import { searchViaBackend } from '../../../../src/store/internal/backend-search';
import { buildStoreItem } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedSearch } from '../../../shared/helpers/parsed-inputs';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 100,
    maxScanItems: 10_000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

const index = { dims: 2, embeddings: { embedQuery: () => [0, 1] } as never };

const backendWith = (matches: unknown[]) => ({
  upsert: jest.fn(),
  delete: jest.fn(),
  query: jest.fn().mockResolvedValue(matches),
});

describe('searchViaBackend', () => {
  it('returns the matched items in the backend s order, each carrying its score', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { a: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
      { namespace: ['users', 'u1'], key: 'a', score: 0.4 },
    ]);
    const found = await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 2),
    );
    expect(found.map((item) => item.score)).toEqual([0.9, 0.4]);
  });

  /** The backend may ignore the prefix; DynamoDB stays canonical. */
  it('drops a match that lies outside the prefix without reading it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { a: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      { namespace: ['orgs', 'o1'], key: 'a', score: 0.9 },
      { namespace: ['users', 'u1'], key: 'a', score: 0.4 },
    ]);
    const found = await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 2),
    );
    expect(found).toHaveLength(1);
    /** Only the in-prefix match is ever addressed; the other is dropped unread. */
    const addressed = mock
      .commandCalls(GetCommand)
      .map((call) => String(call.args[0].input.Key?.PK));
    expect(new Set(addressed)).toEqual(new Set(['STORE#users']));
  });

  /** A stale vector whose item is gone costs a read, not a wrong result. */
  it('drops a match whose canonical item no longer exists', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const backend = backendWith([{ namespace: ['users', 'u1'], key: 'gone', score: 0.9 }]);
    const found = await searchViaBackend(
      context(client),
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 1),
    );
    expect(found).toEqual([]);
  });

  it('refuses a page that reaches beyond maxSearchCandidates before asking the backend', async () => {
    const { client } = createStrictDocumentMock();
    const backend = backendWith([]);
    await expect(
      searchViaBackend(
        context(client, { maxSearchCandidates: 10 }),
        backend as never,
        index,
        parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 5, 10),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
    expect(backend.query).not.toHaveBeenCalled();
  });

  it('refuses a query vector whose width disagrees with index.dims', async () => {
    const { client } = createStrictDocumentMock();
    const backend = backendWith([]);
    await expect(
      searchViaBackend(
        context(client),
        backend as never,
        { dims: 3, embeddings: { embedQuery: () => [0, 1] } as never },
        parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 1),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });

  /** A short page means the backend is exhausted, not that the page was cut. */
  it('stops asking for more once the backend returns fewer than it was asked for', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const backend = backendWith([]);
    const found = await searchViaBackend(
      context(client),
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 5),
    );
    expect(found).toEqual([]);
    expect(backend.query).toHaveBeenCalledTimes(1);
  });

  /**
   * Each round asks for a larger topK and the answer contains the previous
   * round's matches, so re-reading them cost one DynamoDB read — and one S3
   * download for an offloaded item — per match per round.
   */
  it('reads each distinct match once, however many rounds the filter forces', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client, { maxSearchCandidates: 8 });
    const kept = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'keep' },
      { keep: true },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    const dropped = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'drop' },
      { keep: false },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).callsFake((input: { Key?: Record<string, unknown> }) => ({
      Item: String(input.Key?.SK).endsWith('keep') ? kept : dropped,
    }));
    /** One match passes the filter, one never does, so the page stays short and the loop widens. */
    const matches = [
      { namespace: ['users', 'u1'], key: 'keep', score: 0.9 },
      { namespace: ['users', 'u1'], key: 'drop', score: 0.8 },
    ];
    const backend = backendWith(matches);
    const found = await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q', filter: { keep: true } }, 0, 2),
    );
    /** The page stays short because the backend is exhausted, not because it was cut. */
    expect(found.map((item) => item.key)).toEqual(['keep']);
    /** The backend was asked twice; the two items were read exactly once each. */
    expect(backend.query.mock.calls.length).toBeGreaterThan(1);
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  /** A backend that returns one key twice in a round costs one read, not two. */
  it('reads a repeated key once and still scores both matches', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { a: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
      { namespace: ['users', 'u1'], key: 'a', score: 0.4 },
    ]);
    const found = await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 2),
    );
    expect(found.map((item) => item.score)).toEqual([0.9, 0.4]);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('warns when the backend s scores ascend, and forwards its order unchanged', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { a: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      { namespace: ['users', 'u1'], key: 'a', score: 0.1 },
      { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
    ]);
    const found = await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 2),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relevance'), expect.anything());
    expect(found.map((item) => item.score)).toEqual([0.1, 0.9]);
  });

  /** The prefix is checked label by label and never for how many labels it holds. */
  it('bounds the depth of the namespacePrefix the score warning reports', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const filler = Array.from({ length: MAX_LOGGED_LABELS }, (_unused, at) => `d${at}`);
    const deep = ['users', ...filler];
    const record = await buildStoreItem(
      ctx,
      { namespace: deep, key: 'a' },
      { a: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      { namespace: deep, key: 'a', score: 0.1 },
      { namespace: deep, key: 'a', score: 0.9 },
    ]);
    await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: deep, query: 'q' }, 0, 2),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relevance'), {
      namespacePrefix: [...deep.slice(0, MAX_LOGGED_LABELS), `…(len ${deep.length})`],
    });
  });

  /**
   * This line fires in the branch where `parseStoreAddress` refused the match,
   * once per bad match, so a backend answering with many of them writes one
   * unbounded line each. The namespace is bounded in both of its dimensions:
   * a label of a megabyte and a million labels cost the same line otherwise.
   */
  it('bounds the namespace and key it quotes off an unusable backend match', async () => {
    const { client } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const label = 'n'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const key = 'k'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const backend = backendWith([{ namespace: ['users', label], key, score: 0.9 }]);
    await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 1),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable vectorBackend match'), {
      namespace: ['users', truncateForLog(label)],
      key: truncateForLog(key),
      reason: 'VALIDATION',
    });
  });

  it('bounds the depth of a namespace a backend returns, stating the depth it had', async () => {
    const { client } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    /** A `#` in the last label is what `parseStoreAddress` refuses here. */
    const filler = Array.from({ length: MAX_LOGGED_LABELS }, (_unused, at) => `d${at}`);
    const deep = ['users', ...filler, 'a#b'];
    const backend = backendWith([{ namespace: deep, key: 'k', score: 0.9 }]);
    await searchViaBackend(
      ctx,
      backend,
      index,
      parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 1),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable vectorBackend match'), {
      namespace: [...deep.slice(0, MAX_LOGGED_LABELS), `…(len ${deep.length})`],
      key: 'k',
      reason: 'VALIDATION',
    });
  });
});
