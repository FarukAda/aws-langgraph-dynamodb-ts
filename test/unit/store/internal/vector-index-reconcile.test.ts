import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  MAX_LOGGED_LABELS,
  MAX_LOGGED_VALUE_CHARS,
  truncateForLog,
} from '../../../../src/shared/logging/truncate';
import { parseNamespace } from '../../../../src/store/internal/parse';
import { buildStoreItem } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  collectReconcileTargets,
  pruneOrphans,
  pushEmbeddings,
  selectOrphans,
} from '../../../../src/store/internal/vector-index';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

describe('selectOrphans', () => {
  it('returns backend refs that have no live canonical target', () => {
    const live = [
      { namespace: ['users', 'u1'], key: 'a', embedding: [1] },
      { namespace: ['users', 'u1'], key: 'b', embedding: undefined },
    ];
    const backendRefs = [
      { namespace: ['users', 'u1'], key: 'a' },
      { namespace: ['users', 'u1'], key: 'gone' },
    ];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['users', 'u1'], key: 'gone' }]);
  });

  it('treats the same key under different namespaces as distinct', () => {
    const live = [{ namespace: ['a'], key: 'k', embedding: [1] }];
    const backendRefs = [{ namespace: ['b'], key: 'k' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['b'], key: 'k' }]);
  });

  it('does not collide a multi-element namespace with a single element containing the separator', () => {
    const live = [{ namespace: ['a', 'b'], key: 'c', embedding: [1] }];
    const backendRefs = [{ namespace: ['a b'], key: 'c' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['a b'], key: 'c' }]);
  });

  it('treats a live item whose current embedding is undefined as orphan-eligible (empty-text drift)', () => {
    const live = [{ namespace: ['n'], key: 'emptied', embedding: undefined }];
    const backendRefs = [{ namespace: ['n'], key: 'emptied' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['n'], key: 'emptied' }]);
  });
});

describe('pushEmbeddings', () => {
  it('upserts only targets that have an embedding', async () => {
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
      query: jest.fn(),
    };
    const count = await pushEmbeddings(backend, [
      { namespace: ['n'], key: 'a', embedding: [1] },
      { namespace: ['n'], key: 'b', embedding: undefined },
    ]);
    expect(count).toBe(1);
    expect(backend.upsert).toHaveBeenCalledTimes(1);
    expect(backend.upsert).toHaveBeenCalledWith(['n'], 'a', [1]);
  });
});

describe('pruneOrphans', () => {
  it('returns 0 and logs when the backend has no listKeys', async () => {
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const count = await pruneOrphans(
      context(undefined as never, { logger }),
      backend,
      parseNamespace(['n'], 'namespacePrefix'),
      [],
    );
    expect(count).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('prune skipped'), {
      prefix: ['n'],
    });
  });

  /** The prefix is checked label by label and never for how many labels it holds. */
  it('bounds the depth of the prefix the skip line reports', async () => {
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const deep = Array.from({ length: MAX_LOGGED_LABELS + 2 }, (_unused, at) => `d${at}`);
    await pruneOrphans(
      context(undefined as never, { logger }),
      backend,
      parseNamespace(deep, 'namespacePrefix'),
      [],
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('prune skipped'), {
      prefix: [...deep.slice(0, MAX_LOGGED_LABELS), `…(len ${deep.length})`],
    });
  });

  it('deletes backend refs with no live target', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([
        { namespace: ['n'], key: 'live' },
        { namespace: ['n'], key: 'dead' },
      ]),
    };
    const count = await pruneOrphans(
      context(client),
      backend,
      parseNamespace(['n'], 'namespacePrefix'),
      [{ namespace: ['n'], key: 'live', embedding: [1] }],
    );
    expect(count).toBe(1);
    expect(backend.delete).toHaveBeenCalledWith(['n'], 'dead');
    expect(backend.listKeys).toHaveBeenCalledWith(['n']);
  });

  it('re-checks a candidate against DynamoDB before pruning it', async () => {
    // The live-set snapshot and this prune read are not one point in time, so
    // a key written between them looks orphaned. Deleting its vector on that
    // basis silently drops a just-written live item out of semantic search.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: { location: 'INLINE' } } });
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      listKeys: jest
        .fn()
        .mockResolvedValue([{ namespace: ['n'], key: 'written-during-reconcile' }]),
    };
    const count = await pruneOrphans(
      context(client),
      backend,
      parseNamespace(['n'], 'namespacePrefix'),
      [],
    );
    expect(count).toBe(0);
    expect(backend.delete).not.toHaveBeenCalled();
  });

  /**
   * The ref comes back from a consumer's `listKeys`, once per candidate, and
   * nothing this package ran bounded either the labels or how many there are.
   */
  it('bounds the namespace and key it reports for a kept vector', async () => {
    const { client, mock } = createStrictDocumentMock();
    const info = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, info } });
    mock.on(GetCommand).resolves({ Item: { value: { location: 'INLINE' } } });
    const label = 'n'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const key = 'k'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const filler = Array.from({ length: MAX_LOGGED_LABELS }, (_unused, at) => `d${at}`);
    const namespace = [label, ...filler];
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([{ namespace, key }]),
    };
    await expect(
      pruneOrphans(ctx, backend, parseNamespace(['n'], 'namespacePrefix'), []),
    ).resolves.toBe(0);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('item reappeared'), {
      namespace: [
        truncateForLog(label),
        ...filler.slice(0, MAX_LOGGED_LABELS - 1),
        `…(len ${namespace.length})`,
      ],
      key: truncateForLog(key),
    });
  });
});

describe('collectReconcileTargets', () => {
  it('enumerates canonical items under the prefix and recomputes each embedding', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
    const ctx = context(client, { index: { dims: 1, embeddings: embeddings as never } });
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { text: 'hello' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(QueryCommand).resolves({ Items: [record] });

    const targets = await collectReconcileTargets(
      ctx,
      parseNamespace(['users', 'u1'], 'namespacePrefix'),
    );

    expect(targets).toEqual([{ namespace: ['users', 'u1'], key: 'a', embedding: [0.5] }]);
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it('embeds every live item in one embedDocuments call rather than one call per item', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embedDocuments = jest.fn((texts: string[]) => texts.map((t) => [t.length]));
    const embeddings = { embedQuery: jest.fn(), embedDocuments };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never, fields: ['text'] },
    });
    const meta = { createdAt: 'c', updatedAt: 'u' };
    const a = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { text: 'ab' },
      meta,
    );
    const b = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'b' },
      { text: 'abcd' },
      meta,
    );
    mock.on(QueryCommand).resolves({ Items: [a, b] });

    const targets = await collectReconcileTargets(
      ctx,
      parseNamespace(['users', 'u1'], 'namespacePrefix'),
    );

    expect(targets.map((t) => [t.key, t.embedding])).toEqual([
      ['a', [2]],
      ['b', [4]],
    ]);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedDocuments).toHaveBeenCalledWith(['ab', 'abcd']);
  });

  it('skips records that do not match the prefix element-wise', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
    const ctx = context(client, { index: { dims: 1, embeddings: embeddings as never } });
    const match = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'a' },
      { text: 'hi' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const sibling = { ...match, namespace: ['users', 'u10'] };
    mock.on(QueryCommand).resolves({ Items: [match, sibling] });

    const targets = await collectReconcileTargets(
      ctx,
      parseNamespace(['users', 'u1'], 'namespacePrefix'),
    );
    expect(targets.map((t) => t.namespace)).toEqual([['users', 'u1']]);
  });

  it('skips and warns on a foreign row instead of casting it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    // A row whose `namespace` is truthy but not an array — the exact shape the
    // shared narrowing helper exists to reject, and which a raw cast waves through.
    mock.on(QueryCommand).resolves({
      Items: [{ PK: 'STORE#n', SK: 'foreign', namespace: 'not-an-array', key: 'k' }],
    });

    await expect(
      collectReconcileTargets(ctx, parseNamespace(['n'], 'namespacePrefix')),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped a row'),
      expect.objectContaining({ sortKey: 'foreign' }),
    );
  });

  /**
   * This pass walks a whole prefix, so one line per foreign row on a shared
   * table is where an unbounded key costs megabytes of log. Every other
   * row-sourced string a log line quotes is cut at the same cap.
   */
  it('bounds the sort key it reports', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const sortKey = 'z'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    mock.on(QueryCommand).resolves({
      Items: [{ PK: 'STORE#n', SK: sortKey, namespace: 'not-an-array', key: 'k' }],
    });

    await expect(
      collectReconcileTargets(ctx, parseNamespace(['n'], 'namespacePrefix')),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped a row'), {
      sortKey: truncateForLog(sortKey),
    });
  });
});
