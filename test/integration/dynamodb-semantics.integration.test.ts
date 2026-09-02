import { type AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { rejectedItem } from '../../src/shared/dynamodb/conditional-put';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'semantics-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const client = DynamoDBDocument.from(admin);

beforeAll(() => createTable(admin, tableName));
afterAll(async () => {
  await deleteTable(admin, tableName);
  admin.destroy();
});

/** The error a rejected call produced, or undefined when it unexpectedly succeeded. */
async function failureOf(call: Promise<object>): Promise<Error | undefined> {
  return call.then(
    () => undefined,
    (error: Error) => error,
  );
}

describe('DynamoDB semantics the unit mocks assume (TEST-05)', () => {
  it('attaches the rejecting row to ConditionalCheckFailedException as raw AttributeValues', async () => {
    await client.put({
      TableName: tableName,
      Item: { PK: 'sem', SK: 'guard', channel: 'messages', writeGroup: 'g1' },
    });
    const failure = await failureOf(
      client.put({
        TableName: tableName,
        Item: { PK: 'sem', SK: 'guard', channel: 'other', writeGroup: 'g2' },
        ConditionExpression: 'attribute_not_exists(PK)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    expect(failure?.name).toBe('ConditionalCheckFailedException');
    /** The document client leaves an error payload marshalled — exactly what write-guard.ts and rejectedItem rely on. */
    const raw = (failure as { Item?: Record<string, AttributeValue> }).Item;
    expect(raw?.channel).toEqual({ S: 'messages' });
    expect(unmarshall(raw as Record<string, AttributeValue>)).toMatchObject({
      channel: 'messages',
    });
    expect(rejectedItem(failure as Error)).toMatchObject({ channel: 'messages', writeGroup: 'g1' });
  });

  it('rejects duplicate keys inside one BatchWriteItem and one TransactWriteItems', async () => {
    const item = { PK: 'sem', SK: 'dup' };
    await expect(
      client.batchWrite({
        RequestItems: {
          [tableName]: [
            { PutRequest: { Item: item } },
            { PutRequest: { Item: { ...item, v: 2 } } },
          ],
        },
      }),
    ).rejects.toMatchObject({ name: 'ValidationException' });
    await expect(
      client.transactWrite({
        TransactItems: [
          { Put: { TableName: tableName, Item: item } },
          { Put: { TableName: tableName, Item: { ...item, v: 2 } } },
        ],
      }),
    ).rejects.toMatchObject({
      name: expect.stringMatching(/ValidationException|TransactionCanceledException/),
    });
  });

  it('returns an empty page with a LastEvaluatedKey when Limit applies before FilterExpression', async () => {
    for (let i = 0; i < 3; i++) {
      await client.put({ TableName: tableName, Item: { PK: 'page', SK: `r${i}`, keep: i === 2 } });
    }
    const page = await client.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'keep = :keep',
      ExpressionAttributeValues: { ':pk': 'page', ':keep': true },
      Limit: 1,
    });
    expect(page.Items).toEqual([]);
    expect(page.LastEvaluatedKey).toBeDefined();
  });

  it('rejects an item over 400 KB with a ValidationException', async () => {
    await expect(
      client.put({
        TableName: tableName,
        Item: { PK: 'big', SK: 'x', blob: 'x'.repeat(410 * 1024) },
      }),
    ).rejects.toMatchObject({ name: 'ValidationException' });
  });
});
