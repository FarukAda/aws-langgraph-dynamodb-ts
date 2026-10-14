import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { paginateScan } from '../../../../src/shared/dynamodb/paginate';
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
    const inputs = mock.commandCalls(ScanCommand).map((call) => call.args[0].input);
    expect(inputs).toHaveLength(2);
    // The second page resumes exactly where the first stopped, and the first asked from the start.
    expect(inputs[0].ExclusiveStartKey).toBeUndefined();
    expect(inputs[1].ExclusiveStartKey).toEqual({ PK: 'a' });
  });

  it('yields nothing for an empty table (no Items field)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({});
    expect(await collect(paginateScan({ client, params: { TableName: 't' } }))).toEqual([]);
  });
});
