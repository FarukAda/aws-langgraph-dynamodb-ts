import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../../src/index';
import { DDB_LOCAL_CONFIG, createTable, deleteTable } from '../helpers/ddb-local';
import { awsError, installFaults } from '../helpers/fault-injection';

const tableName = 'append-atomicity-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let reader: DynamoDBChatMessageHistory;

beforeAll(async () => {
  await createTable(admin, tableName);
  reader = new DynamoDBChatMessageHistory({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  reader.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

function isTransaction(input: unknown): boolean {
  return Array.isArray((input as { TransactItems?: unknown[] }).TransactItems);
}

describe('addMessages caller-observed atomicity under partial transaction failure', () => {
  it('rolls back the committed first chunk when the second chunk fails', async () => {
    const base = new DynamoDBClient(DDB_LOCAL_CONFIG);
    installFaults(base, [
      {
        match: (_name, input) => isTransaction(input),
        fail: () => awsError('ValidationException', 'injected chunk-2 failure'),
        skip: 1,
        times: 1,
      },
    ]);
    const faulted = new DynamoDBChatMessageHistory({
      tableName,
      client: DynamoDBDocument.from(base),
    });

    const sessionId = 's-atomic';
    const messages = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));

    await expect(faulted.addMessages(sessionId, messages)).rejects.toThrow('injected chunk-2');
    base.destroy();

    const stored = await reader.getMessages(sessionId);
    expect(stored).toHaveLength(0);

    const sessions = await reader.listSessions();
    const meta = sessions.find((session) => session.sessionId === sessionId);
    expect(meta?.messageCount ?? 0).toBe(0);
  });

  it('persists the whole batch when no fault occurs (chunks committed together)', async () => {
    const sessionId = 's-atomic-ok';
    const messages = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));
    await reader.addMessages(sessionId, messages);

    const stored = await reader.getMessages(sessionId);
    expect(stored).toHaveLength(150);
    const sessions = await reader.listSessions();
    expect(sessions.find((session) => session.sessionId === sessionId)?.messageCount).toBe(150);
  });
});
