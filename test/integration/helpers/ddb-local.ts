import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

/** Connection config for the DynamoDB Local container (see docker-compose.yml). */
export const DDB_LOCAL_CONFIG = {
  endpoint: process.env.DDB_LOCAL_ENDPOINT ?? 'http://localhost:8000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

/** Create an on-demand PK/SK table and wait until it is active. */
export async function createTable(admin: DynamoDBClient, tableName: string): Promise<void> {
  await admin.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: tableName });
}

/** Delete a table created by {@link createTable}. */
export async function deleteTable(admin: DynamoDBClient, tableName: string): Promise<void> {
  await admin.send(new DeleteTableCommand({ TableName: tableName }));
}
