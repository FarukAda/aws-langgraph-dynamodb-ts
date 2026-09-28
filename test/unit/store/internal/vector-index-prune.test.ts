import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { parseNamespace } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { pruneOrphans } from '../../../../src/store/internal/vector-index';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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
