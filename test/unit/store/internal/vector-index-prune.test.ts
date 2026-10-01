import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { parseNamespace } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { pruneOrphans } from '../../../../src/store/internal/vector-index';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

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

function backend() {
  return {
    upsert: jest.fn(),
    query: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    listKeys: jest.fn().mockResolvedValue([{ namespace: ['docs'], key: 'd1' }]),
  };
}

/** The item the snapshot saw, yielding no embedding, at revision `rev`. */
const seen = (rev: string) => [{ namespace: ['docs'], key: 'd1', embedding: undefined, rev }];

/** The reconciled prefix, as the store parses it. */
const PREFIX = parseNamespace(['docs'], 'namespacePrefix');

describe('pruneOrphans on a candidate the snapshot saw', () => {
  it('prunes the vector when the row still holds the revision the snapshot read', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'r1' } });
    const vectors = backend();
    await expect(pruneOrphans(context(client), vectors, PREFIX, seen('r1'))).resolves.toBe(1);
    expect(vectors.delete).toHaveBeenCalledWith(['docs'], 'd1');
  });

  it('keeps the vector of an item re-put since the snapshot', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'r2' } });
    const vectors = backend();
    await expect(pruneOrphans(context(client), vectors, PREFIX, seen('r1'))).resolves.toBe(0);
    expect(vectors.delete).not.toHaveBeenCalled();
  });

  it('prunes the vector of an item deleted since the snapshot', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const vectors = backend();
    await expect(pruneOrphans(context(client), vectors, PREFIX, seen('r1'))).resolves.toBe(1);
  });
});

/**
 * With a `ttl`, an item's row outlives the item: past its `ttl` no reader
 * answers it, but DynamoDB's sweep can take days to remove the row. The
 * snapshot leaves such an item out, so its vector is a candidate — and the
 * confirmation read must judge the row as every reader does, or the vector
 * stays until the sweep, logged each reconcile as an item that "reappeared".
 */
describe('pruneOrphans on a candidate whose row has expired but not yet been swept', () => {
  const nowSeconds = FROZEN_NOW_MS / 1000;

  it('prunes the vector, as it would for a row that is gone', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'STORE#docs', ttl: nowSeconds } });
    const vectors = backend();
    await expect(pruneOrphans(context(client), vectors, PREFIX, [])).resolves.toBe(1);
    expect(vectors.delete).toHaveBeenCalledWith(['docs'], 'd1');
  });

  it('keeps the vector of a row whose expiry is still ahead', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'STORE#docs', ttl: nowSeconds + 1 } });
    const vectors = backend();
    await expect(pruneOrphans(context(client), vectors, PREFIX, [])).resolves.toBe(0);
    expect(vectors.delete).not.toHaveBeenCalled();
  });

  /**
   * A read that fails confirms nothing. The delete path keeps the vector and
   * says so at `info`, because a delete has already done its work; a reconcile
   * exists to establish the index, so a confirmation it cannot make fails the
   * call rather than being counted as an item that reappeared.
   */
  it('fails the reconcile when the confirmation read itself fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    const vectors = backend();
    const ctx = { ...context(client), retry: { maxAttempts: 1 } };
    await expect(pruneOrphans(ctx, vectors, PREFIX, [])).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(vectors.delete).not.toHaveBeenCalled();
  });

  it('reads the expiry beside the identity, so the one read answers both', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await pruneOrphans(context(client), backend(), PREFIX, []);
    const read = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(read.ConsistentRead).toBe(true);
    expect(Object.values(read.ExpressionAttributeNames ?? {})).toEqual(
      expect.arrayContaining(['PK', 'ttl']),
    );
  });
});
