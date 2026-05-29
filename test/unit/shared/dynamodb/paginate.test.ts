import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { paginateQuery } from '../../../../src/shared/dynamodb/paginate';
import { AbortError } from '../../../../src/shared/errors/errors';
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

  it('stops yielding once maxItems is reached, even with more pages available', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .resolves({ Items: [{ pk: 'a' }, { pk: 'b' }], LastEvaluatedKey: { pk: 'b' } });
    const items = await collect(paginateQuery({ client, params: { TableName: 't' }, maxItems: 1 }));
    expect(items).toEqual([{ pk: 'a' }]);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('stops at the iteration cap as a runaway guard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: 'loop' } });
    const items = await collect(
      paginateQuery({ client, params: { TableName: 't' }, maxIterations: 2 }),
    );
    expect(items).toEqual([]);
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
