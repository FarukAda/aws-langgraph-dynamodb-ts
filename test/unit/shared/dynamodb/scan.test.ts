import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { paginateScan } from '../../../../src/shared/dynamodb/scan';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('paginateScan', () => {
  it('scans across pages following LastEvaluatedKey', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ id: 'a' }], LastEvaluatedKey: { PK: 'a' } })
      .resolvesOnce({ Items: [{ id: 'b' }] });
    expect(await collect(paginateScan({ client, params: { TableName: 't' } }))).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  it('yields nothing for an empty table (no Items field)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({});
    expect(await collect(paginateScan({ client, params: { TableName: 't' } }))).toEqual([]);
  });
});
