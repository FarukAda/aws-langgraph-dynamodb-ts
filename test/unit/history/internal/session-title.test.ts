import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { removeRolledBackTitle } from '../../../../src/history/internal/session-title';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

const NOW = '2026-08-29T00:00:00.000Z';

/**
 * C4 residual: when a rolled-back append cannot delete the session row it
 * created — because a concurrent append has since added messages to it — the
 * count decrement alone still leaves `title`, derived from a message the
 * caller was told had not persisted, on a row that now belongs to someone
 * else. That is the same content leak C4 is about, in a narrower window.
 */
describe('removeRolledBackTitle', () => {
  it('removes a title this call contributed to a row it created', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(UpdateCommand).resolves({});
    await removeRolledBackTitle(context(client), 's1', NOW, 'tiny message 0');
    const input = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('REMOVE #title');
    expect(input.ConditionExpression).toBe('#c = :now AND #title = :title');
    expect(input.ExpressionAttributeValues).toEqual({ ':now': NOW, ':title': 'tiny message 0' });
    expect(input.Key).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
  });

  it('leaves a title it did not write, without surfacing the rejection', async () => {
    // The row pre-existed this call, or a concurrent caller won the
    // if_not_exists race for the title — either way it is not ours to remove.
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }));
    await expect(
      removeRolledBackTitle(context(client), 's1', NOW, 'ours'),
    ).resolves.toBeUndefined();
  });

  it('rethrows a failure that is not a condition rejection', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await expect(removeRolledBackTitle(context(client), 's1', NOW, 'ours')).rejects.toThrow('boom');
  });
});
