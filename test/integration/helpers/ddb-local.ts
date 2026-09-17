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

/** What {@link createTable} builds beyond the PK/SK key schema. */
export interface CreateTableOptions {
  /**
   * Add the recency index exactly as README's CDK snippet defines it: a GSI
   * named `gsi1` on `gsi1pk`/`gsi1sk`, projecting every attribute.
   */
  recencyIndex?: boolean;
}

/**
 * Create an on-demand PK/SK table, with the recency index when asked for, and
 * wait until it is active.
 */
export async function createTable(
  admin: DynamoDBClient,
  tableName: string,
  options: CreateTableOptions = {},
): Promise<void> {
  const indexKeys = [
    { AttributeName: 'gsi1pk', AttributeType: 'S' as const },
    { AttributeName: 'gsi1sk', AttributeType: 'S' as const },
  ];
  await admin.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        ...(options.recencyIndex ? indexKeys : []),
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      ...(options.recencyIndex
        ? {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: [
                  { AttributeName: 'gsi1pk', KeyType: 'HASH' },
                  { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
                ],
                Projection: { ProjectionType: 'ALL' },
              },
            ],
          }
        : {}),
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: tableName });
}

/** Delete a table created by {@link createTable}. */
export async function deleteTable(admin: DynamoDBClient, tableName: string): Promise<void> {
  await admin.send(new DeleteTableCommand({ TableName: tableName }));
}
