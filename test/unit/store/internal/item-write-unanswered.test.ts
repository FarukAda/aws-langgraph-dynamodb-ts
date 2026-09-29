import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedPut } from '../../../shared/helpers/parsed-inputs';

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => `${[...parts, objectId].join('/')}.bin`,
    upload: jest.fn((key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}

function context(
  client: StoreContext['client'],
  offloader: ReturnType<typeof trackingOffloader>,
): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
    offloader: offloader as never,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  };
}

const OP: PutOperation = { namespace: ['users', 'u1'], key: 'profile', value: { name: 'Ada' } };

describe('store.put after a write that got no answer', () => {
  it('keeps its upload although the read finds another revision', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .resolvesOnce({})
      .resolves({ Item: { rev: 'someone-else' } });
    mock.on(TransactWriteCommand).rejects(Object.assign(new Error('cut'), { name: 'AbortError' }));
    const s3 = trackingOffloader();
    await expect(putItem(context(client, s3), parsedPut(OP))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(s3.deleteBatch).not.toHaveBeenCalled();
  });
});
