import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
import { readCandidate } from '../../../../src/store/internal/get-item';
import {
  parseNamespace,
  parseNamespacePrefix,
  parseSearch,
} from '../../../../src/store/internal/parse';
import { buildStoreRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { collectReconcileTargets } from '../../../../src/store/internal/vector-index';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const timestamps = { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' };

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

function s3Failure(causeName: string): Error {
  return new DynamoDBLangGraphError(
    's3 failed',
    ErrorCode.S3_OFFLOAD_FAILED,
    {},
    Object.assign(new Error(causeName), { name: causeName }),
  );
}

/** An offloader whose downloads are answered per S3 key. */
function offloaderFor(downloads: Record<string, () => Promise<Uint8Array>>) {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    download: jest.fn(async (key: string) => downloads[key]()),
    assertOwnedKey: () => undefined,
    deleteBatch: jest.fn(),
  };
}

const keyOf = (record: Awaited<ReturnType<typeof buildStoreRow>>): string =>
  (record.value as { s3Key: string }).s3Key;

const gone = (): Promise<Uint8Array> => {
  throw s3Failure('NoSuchKey');
};
const bytesOf = (value: object) => (): Promise<Uint8Array> =>
  Promise.resolve(new TextEncoder().encode(JSON.stringify(value)));

/**
 * A row read by a Query names an object a concurrent put may already have
 * replaced, and released, by the time it is downloaded — the window `get`
 * already covers with one consistent re-read. A search reads a whole page
 * before it downloads anything, so its window is the widest, and a search
 * that fails on it fails for a row that is live and readable a moment later.
 */
describe('a search whose candidate was overwritten between the page and the download', () => {
  async function rows(ctx: StoreContext) {
    const old = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { body: 'v1' },
      { ...timestamps, rev: 'A' },
    );
    const replaced = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { body: 'v2' },
      { ...timestamps, rev: 'B' },
    );
    const other = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'b' },
      { body: 'other' },
      { ...timestamps, rev: 'C' },
    );
    return { old, replaced, other };
  }

  it('re-reads the row once and answers with the value the overwrite stored', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = context(client, { offloader: offloaderFor(downloads) as never });
    const { old, replaced, other } = await rows(ctx);
    downloads[keyOf(old)] = gone;
    downloads[keyOf(replaced)] = bytesOf({ body: 'v2' });
    downloads[keyOf(other)] = bytesOf({ body: 'other' });
    mock.on(QueryCommand).resolves({ Items: [old, other] });
    mock.on(GetCommand).resolves({ Item: replaced });

    const results = await searchItems(
      ctx,
      parseSearch(parseNamespacePrefix(['docs'], 'namespacePrefix'), { limit: 10 }),
    );

    expect(results.map((item) => [item.key, item.value])).toEqual([
      ['a', { body: 'v2' }],
      ['b', { body: 'other' }],
    ]);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('drops a candidate whose row the re-read finds gone', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = context(client, { offloader: offloaderFor(downloads) as never });
    const { old, other } = await rows(ctx);
    downloads[keyOf(old)] = gone;
    downloads[keyOf(other)] = bytesOf({ body: 'other' });
    mock.on(QueryCommand).resolves({ Items: [old, other] });
    mock.on(GetCommand).resolves({});

    const results = await searchItems(
      ctx,
      parseSearch(parseNamespacePrefix(['docs'], 'namespacePrefix'), { limit: 10 }),
    );

    expect(results.map((item) => item.key)).toEqual(['b']);
  });

  it('still fails when the re-read finds the same row pointing at the missing object', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = context(client, { offloader: offloaderFor(downloads) as never });
    const { old } = await rows(ctx);
    downloads[keyOf(old)] = gone;
    mock.on(QueryCommand).resolves({ Items: [old] });
    mock.on(GetCommand).resolves({ Item: old });

    await expect(
      searchItems(
        ctx,
        parseSearch(parseNamespacePrefix(['docs'], 'namespacePrefix'), { limit: 10 }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
  });
});

describe('readCandidate', () => {
  it('hands back the row it finally decoded beside its item', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = context(client, { offloader: offloaderFor(downloads) as never });
    const old = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { body: 'v1' },
      { ...timestamps, rev: 'A' },
    );
    const replaced = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { body: 'v2' },
      { ...timestamps, rev: 'B' },
    );
    downloads[keyOf(old)] = gone;
    downloads[keyOf(replaced)] = bytesOf({ body: 'v2' });
    mock.on(GetCommand).resolves({ Item: replaced });

    const read = await readCandidate(ctx, old);

    expect(read?.row.rev).toBe('B');
    expect(read?.item.value).toEqual({ body: 'v2' });
  });
});

describe('a reconcile whose candidate was overwritten between the page and the download', () => {
  it('re-reads the row and reconciles the value and revision the overwrite stored', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map((text) => [text.length])),
    };
    const ctx = context(client, {
      offloader: offloaderFor(downloads) as never,
      index: { dims: 1, embeddings: embeddings as never, fields: ['text'] },
    });
    const old = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { text: 'v1' },
      { ...timestamps, rev: 'A' },
    );
    const replaced = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { text: 'version two' },
      { ...timestamps, rev: 'B' },
    );
    downloads[keyOf(old)] = gone;
    downloads[keyOf(replaced)] = bytesOf({ text: 'version two' });
    mock.on(QueryCommand).resolves({ Items: [old] });
    mock.on(GetCommand).resolves({ Item: replaced });

    const targets = await collectReconcileTargets(ctx, parseNamespace(['docs'], 'namespacePrefix'));

    expect(targets).toEqual([
      { namespace: ['docs'], key: 'a', embedding: ['version two'.length], rev: 'B' },
    ]);
  });

  it('leaves out a candidate whose row the re-read finds gone', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = context(client, { offloader: offloaderFor(downloads) as never });
    const old = await buildStoreRow(
      ctx,
      { namespace: ['docs'], key: 'a' },
      { text: 'v1' },
      { ...timestamps, rev: 'A' },
    );
    downloads[keyOf(old)] = gone;
    mock.on(QueryCommand).resolves({ Items: [old] });
    mock.on(GetCommand).resolves({});

    await expect(
      collectReconcileTargets(ctx, parseNamespace(['docs'], 'namespacePrefix')),
    ).resolves.toEqual([]);
  });
});
