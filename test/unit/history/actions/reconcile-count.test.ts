import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { reconcileMessageCount } from '../../../../src/history/actions/reconcile-count';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

describe('reconcileMessageCount', () => {
  it('sums a server-side COUNT across pages and writes the authoritative count', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { messageCount: 99 } });
    mock
      .on(QueryCommand)
      .resolvesOnce({ Count: 2, LastEvaluatedKey: { PK: 's1', SK: 'MSG#x' } })
      .resolves({ Count: 1 });
    mock.on(UpdateCommand).resolves({});

    const result = await reconcileMessageCount(context(client), 's1');

    expect(result).toBe(3);
    const query = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.Select).toBe('COUNT');
    // Expired-but-unswept rows are invisible to getMessages, so counting them
    // would "repair" the count to a number the read path never returns (HIST-08).
    expect(query.FilterExpression).toBe('attribute_not_exists(#ttl) OR #ttl > :now');
    expect(query.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#sk': 'SK', '#ttl': 'ttl' });
    expect(query.ExpressionAttributeValues?.[':now']).toBe(Math.floor(FROZEN_NOW_MS / 1000));
    expect(query.ExpressionAttributeValues?.[':pk']).toBe('HIST#s1');
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toBe('SET #count = :count');
    expect(update.ExpressionAttributeValues?.[':count']).toBe(3);
    // Pinned to the value the row held when the count was computed, so a
    // concurrent append fails the write instead of being clobbered by it.
    expect(update.ConditionExpression).toBe('attribute_exists(PK) AND #count = :expected');
    expect(update.ExpressionAttributeValues?.[':expected']).toBe(99);
  });

  it('treats a missing Count as zero', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { messageCount: 0 } });
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
    mock.on(GetCommand).resolves({});
    await expect(reconcileMessageCount(context(client), 'ghost')).rejects.toMatchObject({
      name: 'ConflictError',
      code: ErrorCode.CONDITION_CONFLICT,
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('rethrows a non-conditional-check error unchanged', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { messageCount: 0 } });
    mock.on(QueryCommand).resolves({ Count: 0 });
    mock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await expect(reconcileMessageCount(context(client), 's1')).rejects.toMatchObject({
      name: 'ValidationException',
      message: 'boom',
    });
  });
});

describe('reconcileMessageCount is safe on a live session (HIST-09)', () => {
  const rejected = () =>
    Object.assign(new Error('cond failed'), { name: 'ConditionalCheckFailedException' });

  /**
   * The write used to be unconditional, so an append landing between the count
   * and the write was silently discarded — on exactly the sessions an operator
   * reaches for this tool to repair. It now recounts and tries again.
   */
  it('recounts and retries when an append lands while it counts', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .resolvesOnce({ Item: { messageCount: 5 } })
      .resolves({ Item: { messageCount: 6 } });
    mock.on(QueryCommand).resolvesOnce({ Count: 5 }).resolves({ Count: 6 });
    mock.on(UpdateCommand).rejectsOnce(rejected()).resolves({});

    await expect(reconcileMessageCount(context(client), 's1')).resolves.toBe(6);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(2);
    const second = mock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(second.ExpressionAttributeValues?.[':expected']).toBe(6);
  });

  it('gives up with a ConflictError when the session never settles', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { messageCount: 1 } });
    mock.on(QueryCommand).resolves({ Count: 1 });
    mock.on(UpdateCommand).rejects(rejected());
    await expect(reconcileMessageCount(context(client), 'busy')).rejects.toMatchObject({
      name: 'ConflictError',
      code: ErrorCode.CONDITION_CONFLICT,
    });
  });

  it('pins the absence of the attribute on a row written before it existed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: {} });
    mock.on(QueryCommand).resolves({ Count: 4 });
    mock.on(UpdateCommand).resolves({});
    await expect(reconcileMessageCount(context(client), 'old')).resolves.toBe(4);
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(#count)',
    );
  });
});
