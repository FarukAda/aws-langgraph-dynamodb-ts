import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { reconcileMessageCount } from '../../../../src/history/actions/reconcile-count';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

describe('reconcileMessageCount', () => {
  it('sums a server-side COUNT across pages and writes the authoritative count', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .resolvesOnce({ Count: 2, LastEvaluatedKey: { PK: 's1', SK: 'MSG#x' } })
      .resolves({ Count: 1 });
    mock.on(UpdateCommand).resolves({});

    const result = await reconcileMessageCount(context(client), 's1');

    expect(result).toBe(3);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.Select).toBe('COUNT');
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toBe('SET #count = :count');
    expect(update.ExpressionAttributeValues?.[':count']).toBe(3);
  });

  it('treats a missing Count as zero', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({});
    mock.on(UpdateCommand).resolves({});
    await expect(reconcileMessageCount(context(client), 's1')).resolves.toBe(0);
  });

  it('rejects an empty session id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(reconcileMessageCount(context(client), '')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('throws ConflictError instead of creating a junk row when the session does not exist', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Count: 0 });
    mock
      .on(UpdateCommand)
      .rejects(
        Object.assign(new Error('cond failed'), { name: 'ConditionalCheckFailedException' }),
      );
    await expect(reconcileMessageCount(context(client), 'ghost')).rejects.toMatchObject({
      name: 'ConflictError',
      code: ErrorCode.CONDITION_CONFLICT,
    });
  });
});
