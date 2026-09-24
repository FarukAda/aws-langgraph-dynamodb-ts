import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { wrapForeignError } from '../../../../src/shared/errors/boundary';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { abortError, retryExhaustedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { buildStoreItem } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { searchViaBackend } from '../../../../src/store/internal/vector-index';
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

const ITEM_TIMES = { createdAt: 'c', updatedAt: 'u' };
const PREFIX_QUERY = parsedSearch({ namespacePrefix: ['users'], query: 'q' }, 0, 2);

const backendWith = (matches: unknown[]) => ({
  upsert: jest.fn(),
  delete: jest.fn(),
  query: jest.fn().mockResolvedValue(matches),
});

/**
 * A read that failed is not a match that is missing. The in-DynamoDB path
 * fails the search rather than shortening it (`table-search.ts`), and under
 * throttling the two paths answered the same question differently: one raised,
 * the other handed back a page one item short with a `warn` the default logger
 * does not print. `fetchMatch` exists for the one case its own documentation
 * names — a backend key this store cannot address — and that case is kept.
 */
describe('searchViaBackend when a match cannot be read', () => {
  const twoMatches = [
    { namespace: ['users', 'u1'], key: 'k1', score: 0.9 },
    { namespace: ['users', 'u1'], key: 'k2', score: 0.8 },
  ];

  const propagated: [string, Error][] = [
    ['a read that spent its retry budget', retryExhaustedError('spent', 2)],
    ['a failure from below the library', wrapForeignError(new Error('denied'), 'store.get')],
    ['a cancelled read', abortError()],
    [
      'a payload that can never be read',
      new DynamoDBLangGraphError('corrupt', ErrorCode.PAYLOAD_CORRUPT),
    ],
    [
      'an offloaded object that could not be fetched',
      new DynamoDBLangGraphError('gone', ErrorCode.S3_OFFLOAD_FAILED),
    ],
  ];

  it.each(propagated)('fails the whole search for %s', async (_label, failure) => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'k1' },
      { a: 1 },
      ITEM_TIMES,
    );
    mock.on(GetCommand).callsFake((input: { Key?: Record<string, unknown> }) => {
      if (String(input.Key?.SK).endsWith('k1')) return { Item: record };
      throw failure;
    });
    const backend = backendWith(twoMatches);
    await expect(
      searchViaBackend({ ...ctx, vectorBackend: backend, index }, PREFIX_QUERY),
    ).rejects.toMatchObject({ code: (failure as DynamoDBLangGraphError).code });
  });

  /** The repro: one throttled `Get`, and the page came back one item short. */
  it('fails rather than shortening the page when a read is throttled out of its budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client, { retry: { maxAttempts: 1 } });
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'k1' },
      { a: 1 },
      ITEM_TIMES,
    );
    mock.on(GetCommand).callsFake((input: { Key?: Record<string, unknown> }) => {
      if (String(input.Key?.SK).endsWith('k1')) return { Item: record };
      throw Object.assign(new Error('slow down'), {
        name: 'ProvisionedThroughputExceededException',
      });
    });
    const backend = backendWith(twoMatches);
    await expect(
      searchViaBackend({ ...ctx, vectorBackend: backend, index }, PREFIX_QUERY),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
  });

  /**
   * A `VALIDATION` error is not by itself the address the drop exists for. The
   * decode raises one too — for a row offloaded to S3 read by an adapter with
   * no `s3` configured, for a descriptor written by a newer library, for an
   * `s3Key` outside the row's own path — and every one of those is a read that
   * did not happen. The in-DynamoDB path raises them (`table-search.ts` decodes
   * with no catch at all), so dropping them here is the same disagreement this
   * function was changed to end.
   */
  it('fails the whole search for a payload the decode refuses', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'k1' },
      { a: 1 },
      ITEM_TIMES,
    );
    mock.on(GetCommand).callsFake((input: { Key?: Record<string, unknown> }) => {
      if (String(input.Key?.SK).endsWith('k1')) return { Item: record };
      return {
        Item: {
          ...record,
          SK: 'u1#k2',
          key: 'k2',
          value: { location: 'S3', s3Key: 'o', serdeType: 'json', compressed: false },
        },
      };
    });
    const backend = backendWith(twoMatches);
    await expect(
      searchViaBackend({ ...ctx, vectorBackend: backend, index }, PREFIX_QUERY),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 's3' } });
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The case this function exists for: a backend key this store cannot address.
   * The namespace element carries the reserved separator, so no `Get` is issued
   * for it at all — which is what makes this the address and not a read.
   */
  it('still drops a match the store cannot address, with its warn', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    const record = await buildStoreItem(
      ctx,
      { namespace: ['users', 'u1'], key: 'k1' },
      { a: 1 },
      ITEM_TIMES,
    );
    mock.on(GetCommand).resolves({ Item: record });
    const backend = backendWith([
      twoMatches[0],
      { namespace: ['users', 'u#1'], key: 'k2', score: 0.8 },
    ]);
    const found = await searchViaBackend({ ...ctx, vectorBackend: backend, index }, PREFIX_QUERY);
    expect(found.map((item) => item.key)).toEqual(['k1']);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unusable'),
      expect.objectContaining({ key: 'k2', reason: 'VALIDATION' }),
    );
  });
});
