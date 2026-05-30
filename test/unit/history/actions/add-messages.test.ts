import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  it('writes one item per message and the count in a single transaction', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client), 's1', [new HumanMessage('a'), new AIMessage('b')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items[0].Update?.UpdateExpression).toContain('ADD #count :n');
    expect(items[0].Update?.ExpressionAttributeValues?.[':n']).toBe(2);
    expect(items[0].Update?.ExpressionAttributeValues?.[':title']).toBe('a');
    expect(items[1].Put?.Item?.SK).toBe('MSG#U0');
    expect(items[2].Put?.Item?.SK).toBe('MSG#U1');
  });

  it('omits the title clause when there is no human message', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client), 's1', [new AIMessage('only assistant')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[0].Update?.UpdateExpression).not.toContain('#title');
  });

  it('is a no-op for an empty message list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await addMessages(context(client), 's1', []);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects an empty session id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(addMessages(context(client), '', [new HumanMessage('hi')])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('establishes the ttl anchor and stamps it on every message item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(UpdateCommand).resolves({ Attributes: { ttl: 4242 } });
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 's1', [
      new HumanMessage('hi'),
      new AIMessage('yo'),
    ]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const puts = items.slice(1);
    expect(puts.every((p) => p.Put?.Item?.ttl === 4242)).toBe(true);
  });

  it('splits past the per-transaction limit into multiple transactions with a correct total count', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const many = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));
    await addMessages(context(client), 's1', many);
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    const counts = calls.map(
      (call) =>
        (call.args[0].input.TransactItems ?? [])[0].Update?.ExpressionAttributeValues?.[':n'],
    );
    expect(counts).toEqual([99, 51]);
    expect(counts[0] + counts[1]).toBe(150);
  });

  it('rethrows a transaction failure without cleanup when no offloader is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(addMessages(context(client), 's1', [new HumanMessage('hi')])).rejects.toThrow(
      'down',
    );
  });

  it('cleans up offloaded objects when the transaction fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
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
