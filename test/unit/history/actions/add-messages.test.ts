import { BatchWriteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { addMessages } from '../../../../src/history/actions/add-messages';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function sequentialUlid(): () => string {
  let n = 0;
  return () => `U${n++}`;
}

function context(
  client: HistoryContext['client'],
  extra?: Partial<HistoryContext>,
): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: sequentialUlid(),
    ...extra,
  };
}

describe('addMessages', () => {
  it('batch-writes one item per message and atomically updates the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    await addMessages(context(client), 's1', [new HumanMessage('a'), new AIMessage('b')]);
    const writes = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems.history;
    expect(writes).toHaveLength(2);
    expect(writes[0].PutRequest.Item.SK).toBe('MSG#U0');
    expect(writes[1].PutRequest.Item.SK).toBe('MSG#U1');
    const upd = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual({ PK: 's1', SK: 'SESSION' });
    expect(upd.UpdateExpression).toContain('ADD #count :n');
    expect(upd.ExpressionAttributeValues[':n']).toBe(2);
    expect(upd.ExpressionAttributeValues[':title']).toBe('a');
  });

  it('omits the title clause when there is no human message', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    await addMessages(context(client), 's1', [new AIMessage('only assistant')]);
    const upd = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).not.toContain('#title');
    expect(upd.ExpressionAttributeValues[':title']).toBeUndefined();
  });

  it('is a no-op for an empty message list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await addMessages(context(client), 's1', []);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rejects an empty session id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(addMessages(context(client), '', [new HumanMessage('hi')])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('stamps a ttl on every message item and the session update on a new session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 's1', [new HumanMessage('hi')]);
    const item =
      mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems.history[0].PutRequest.Item;
    expect(typeof item.ttl).toBe('number');
    const upd = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(typeof upd.ExpressionAttributeValues[':ttl']).toBe('number');
    expect(upd.UpdateExpression).toContain('#ttl');
  });

  it('reuses the stored creation-anchored ttl on a later append', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { ttl: 5000 } });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 's1', [new HumanMessage('hi')]);
    const item =
      mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems.history[0].PutRequest.Item;
    expect(item.ttl).toBe(5000);
    const upd = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ExpressionAttributeValues[':ttl']).toBe(5000);
  });

  it('rethrows a batch-write failure without cleanup when no offloader is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(addMessages(context(client), 's1', [new HumanMessage('hi')])).rejects.toThrow(
      'down',
    );
  });

  it('cleans up offloaded objects when the batch write fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: string[]) => parts.join('/'),
      upload: async (key: string) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    await expect(
      addMessages(context(client, { offloader: offloader as never }), 's1', [
        new HumanMessage('hi'),
      ]),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['s1/U0']);
  });
});
