/**
 * Test harness for DynamoDB Local.
 *
 * Provides:
 *   - A DynamoDB client pointed at localhost:8000 (the docker-compose service)
 *   - Table lifecycle helpers: create and drop per schema the library expects
 *   - A liveness check so missing docker fails the suite early with a clear msg
 *     instead of timing out on every test
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

// Duck-type instead of `instanceof` to match the repo's "no instanceof" lint rule.
function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err) {
    const n = (err as { name: unknown }).name;
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

export const DDB_LOCAL_ENDPOINT = process.env.DDB_LOCAL_ENDPOINT ?? 'http://localhost:8000';

/**
 * Build a DynamoDB client pointed at the local instance. Uses dummy credentials
 * — DDB Local accepts anything but still requires non-empty strings.
 */
export function makeLocalClient(): { ddb: DynamoDBClient; doc: DynamoDBDocument } {
  const ddb = new DynamoDBClient({
    endpoint: DDB_LOCAL_ENDPOINT,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocument.from(ddb);
  return { ddb, doc };
}

/**
 * Verify DDB Local is reachable. Returns a human-readable message on failure
 * so the suite can `fail()` with guidance rather than a raw timeout.
 */
export async function assertDdbLocalReachable(client: DynamoDBClient): Promise<void> {
  try {
    await client.send(new ListTablesCommand({}));
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
    throw new Error(
      `Could not reach DynamoDB Local at ${DDB_LOCAL_ENDPOINT}. ` +
        `Start it with: docker compose up -d. Original error: ${message}`,
      { cause: err },
    );
  }
}

interface TableSchema {
  TableName: string;
  partitionKey: string;
  sortKey?: string;
  partitionKeyType?: 'S' | 'N';
  sortKeyType?: 'S' | 'N';
  ttlAttribute?: string;
}

async function waitForTableActive(client: DynamoDBClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await client.send(new DescribeTableCommand({ TableName: name }));
      if (result.Table?.TableStatus === 'ACTIVE') return;
    } catch {
      /* table may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Table ${name} did not reach ACTIVE within 6s`);
}

async function createTable(client: DynamoDBClient, schema: TableSchema): Promise<void> {
  const AttributeDefinitions: { AttributeName: string; AttributeType: 'S' | 'N' }[] = [
    { AttributeName: schema.partitionKey, AttributeType: schema.partitionKeyType ?? 'S' },
  ];
  const KeySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[] = [
    { AttributeName: schema.partitionKey, KeyType: 'HASH' },
  ];
  if (schema.sortKey) {
    AttributeDefinitions.push({
      AttributeName: schema.sortKey,
      AttributeType: schema.sortKeyType ?? 'S',
    });
    KeySchema.push({ AttributeName: schema.sortKey, KeyType: 'RANGE' });
  }

  try {
    await client.send(
      new CreateTableCommand({
        TableName: schema.TableName,
        AttributeDefinitions,
        KeySchema,
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (err) {
    // Swallow "already exists" — a prior test run may have leaked.
    if (errorName(err) !== 'ResourceInUseException') throw err;
  }

  await waitForTableActive(client, schema.TableName);

  // DDB Local ignores TTL at expiry time but accepts the config. We still
  // configure it so the library's write path — which reads table TTL once via
  // validation — behaves identically to production.
  if (schema.ttlAttribute) {
    try {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: schema.TableName,
          TimeToLiveSpecification: {
            AttributeName: schema.ttlAttribute,
            Enabled: true,
          },
        }),
      );
    } catch {
      /* TTL may already be set from a leaked table */
    }
  }
}

export async function dropTable(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: name }));
  } catch (err) {
    if (errorName(err) !== 'ResourceNotFoundException') throw err;
  }
}

/**
 * Create all four tables the library expects. Returns the table names so tests
 * can thread them into saver/store/history configs.
 */
export async function createAllTables(
  client: DynamoDBClient,
  prefix: string,
): Promise<{
  checkpointsTable: string;
  writesTable: string;
  memoryTable: string;
  chatHistoryTable: string;
}> {
  const names = {
    checkpointsTable: `${prefix}-checkpoints`,
    writesTable: `${prefix}-writes`,
    memoryTable: `${prefix}-memory`,
    chatHistoryTable: `${prefix}-chat-history`,
  };

  await Promise.all([
    createTable(client, {
      TableName: names.checkpointsTable,
      partitionKey: 'thread_id',
      sortKey: 'checkpoint_id',
      ttlAttribute: 'ttl',
    }),
    createTable(client, {
      TableName: names.writesTable,
      partitionKey: 'thread_id_checkpoint_id_checkpoint_ns',
      sortKey: 'task_id_idx',
      ttlAttribute: 'ttl',
    }),
    createTable(client, {
      TableName: names.memoryTable,
      partitionKey: 'user_id',
      sortKey: 'namespace_key',
      ttlAttribute: 'ttl',
    }),
    createTable(client, {
      TableName: names.chatHistoryTable,
      partitionKey: 'userId',
      sortKey: 'sessionId',
      ttlAttribute: 'ttl',
    }),
  ]);

  return names;
}

export async function dropAllTables(
  client: DynamoDBClient,
  names: Record<string, string>,
): Promise<void> {
  await Promise.all(Object.values(names).map((n) => dropTable(client, n)));
}

/**
 * Generate a unique table prefix per test file so parallel test runs (if ever
 * enabled) don't collide, and leaked tables from earlier runs don't interfere.
 */
export function uniquePrefix(label: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `it-${label}-${Date.now()}-${rand}`;
}
