import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { paginateQuery } from '../../../../src/shared/dynamodb/paginate';
import { AbortError, ResultTruncatedError } from '../../../../src/shared/errors/errors';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('paginateQuery', () => {
  it('follows LastEvaluatedKey across pages, including an empty middle page', () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ pk: 'a' }], LastEvaluatedKey: { pk: 'a' } })
      .resolvesOnce({ Items: [], LastEvaluatedKey: { pk: 'a2' } })
      .resolvesOnce({ Items: [{ pk: 'b' }] });
    return expect(collect(paginateQuery({ client, params: { TableName: 't' } }))).resolves.toEqual([
      { pk: 'a' },
      { pk: 'b' },
    ]);
  });

  it('aborts before the first page when the signal is already aborted', async () => {
    const { client } = createStrictDocumentMock();
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(paginateQuery({ client, params: { TableName: 't' }, signal: controller.signal })),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('throws ResultTruncatedError when maxItems is reached with more pages available', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .resolves({ Items: [{ pk: 'a' }, { pk: 'b' }], LastEvaluatedKey: { pk: 'b' } });
    await expect(
      collect(paginateQuery({ client, params: { TableName: 't' }, maxItems: 1 })),
    ).rejects.toBeInstanceOf(ResultTruncatedError);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('throws ResultTruncatedError at the iteration cap when data remains', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: 'loop' } });
    await expect(
      collect(paginateQuery({ client, params: { TableName: 't' }, maxIterations: 2 })),
    ).rejects.toBeInstanceOf(ResultTruncatedError);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('handles a page that returns no Items field', () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolvesOnce({});
    return expect(collect(paginateQuery({ client, params: { TableName: 't' } }))).resolves.toEqual(
      [],
    );
  });
});
