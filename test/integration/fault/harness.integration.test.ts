import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { DDB_LOCAL_CONFIG, createTable, deleteTable } from '../helpers/ddb-local';
import { awsError, installFaults } from '../helpers/fault-injection';

const tableName = 'fault-harness-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);

beforeAll(() => createTable(admin, tableName));
afterAll(async () => {
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('fault-injection harness', () => {
  it('lets the first matching command through and fails the second', async () => {
    const client = new DynamoDBClient(DDB_LOCAL_CONFIG);
    installFaults(client, [
      {
        match: (name) => name === 'PutItemCommand',
        fail: () => awsError('ValidationException', 'injected'),
        skip: 1,
        times: 1,
      },
    ]);
    const doc = DynamoDBDocument.from(client);

    await expect(
      doc.put({ TableName: tableName, Item: { PK: 'p', SK: 'a' } }),
    ).resolves.toBeDefined();
    await expect(doc.put({ TableName: tableName, Item: { PK: 'p', SK: 'b' } })).rejects.toThrow(
      'injected',
    );
    await expect(
      doc.put({ TableName: tableName, Item: { PK: 'p', SK: 'c' } }),
    ).resolves.toBeDefined();

    client.destroy();
  });
});
