import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { DynamoDBStore } from '../../../../src/store/store';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

describe('store scans and maxIterations', () => {
  it('stops a rootless listing after maxIterations pages that hold no store rows', async () => {
    const { client, mock } = createStrictDocumentMock();
    let page = 0;
    mock.on(ScanCommand).callsFake(() => {
      page += 1;
      return { Items: [], LastEvaluatedKey: { PK: `p${page}`, SK: 's' } };
    });
    const store = new DynamoDBStore({
      tableName: 'tbl',
      client,
      logger: SILENT_LOGGER,
      maxIterations: 3,
    });
    await expect(store.listNamespaces()).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxIterations' },
    });
    expect(mock.commandCalls(ScanCommand)).toHaveLength(3);
  });
});
