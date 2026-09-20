import {
  CreateTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

/**
 * Create the on-demand `PK`/`SK` table this tier's suites write to, and wait
 * until it is usable.
 *
 * On demand rather than provisioned so a contention arm cannot be throttled
 * into a failure that looks like the behaviour under test, and so a run that
 * dies before its `afterAll` leaves nothing accruing.
 *
 * `tableName` must stay inside the `aws-langgraph-*test-*` prefix the test
 * role is scoped to: a name outside it is refused with `AccessDenied` instead
 * of creating a table nobody cleans up.
 */
export async function createTestTable(admin: DynamoDBClient, tableName: string): Promise<void> {
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
  await waitUntilTableExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
}
