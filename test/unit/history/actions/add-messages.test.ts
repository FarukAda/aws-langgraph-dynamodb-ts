import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { addMessages } from '../../../../src/history/actions/add-messages';
import { buildSessionItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(
  client: HistoryContext['client'],
  extra?: Partial<HistoryContext>,
): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER, ...extra };
}
const conflict = () =>
  Object.assign(new Error('race'), { name: 'ConditionalCheckFailedException' });

describe('addMessages', () => {
  it('creates a new session with version 1, a derived title, and attribute_not_exists guard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await addMessages(context(client), 'sess-1', [new HumanMessage('What is DynamoDB?')]);
    const input = mock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item.version).toBe(1);
    expect(input.Item.messageCount).toBe(1);
    expect(input.Item.title).toBe('What is DynamoDB?');
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('appends to an existing session, bumping the version under a version guard', async () => {
    const { client, mock } = createStrictDocumentMock();
    const stored = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
    const existing = await buildSessionItem(context(client), 'sess-1', stored, {
      version: 4,
      createdAt: 'c',
      updatedAt: 'u',
      title: 'hi',
    });
    mock.on(GetCommand).resolves({ Item: existing });
    mock.on(PutCommand).resolves({});
    await addMessages(context(client), 'sess-1', [new AIMessage('hello')]);
    const input = mock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item.version).toBe(5);
    expect(input.Item.messageCount).toBe(2);
    expect(input.ConditionExpression).toBe('#v = :v');
    expect(input.ExpressionAttributeValues).toEqual({ ':v': 4 });
  });

  it('retries the read-modify-write when a concurrent writer wins', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejectsOnce(conflict()).resolvesOnce({});
    await addMessages(context(client), 'sess-1', [new HumanMessage('hi')]);
    expect(mock.commandCalls(PutCommand)).toHaveLength(2);
  });

  it('throws CONDITION_CONFLICT after retries are exhausted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(conflict());
    await expect(
      addMessages(context(client), 'sess-1', [new HumanMessage('hi')]),
    ).rejects.toMatchObject({
      code: ErrorCode.CONDITION_CONFLICT,
    });
  });

  it('is a no-op for an empty message list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await addMessages(context(client), 'sess-1', []);
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects an empty session id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(addMessages(context(client), '', [new HumanMessage('hi')])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('stamps a ttl when configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 'sess-1', [
      new HumanMessage('hi'),
    ]);
    expect(typeof mock.commandCalls(PutCommand)[0].args[0].input.Item.ttl).toBe('number');
  });
});
