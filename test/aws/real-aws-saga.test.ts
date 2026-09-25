import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { appendChunks } from '../../src/history/internal/append';
import { parseSessionId } from '../../src/history/internal/parse';
import {
  type MessageRow,
  messageSortKey,
  messageSortKeyPrefix,
  SESSION_SORT_KEY,
  sessionPartition,
} from '../../src/history/internal/rows';
import type { HistoryContext } from '../../src/history/internal/setup';
import { PayloadLocation } from '../../src/shared/codec/codec';
import { JSON_SERDE } from '../../src/shared/codec/json-serde';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { liveRegion } from './helpers/env';

const clientConfig = { region: liveRegion() };
const tableName = `aws-langgraph-sagatest-${randomUUID()}`;
const sessionId = 'saga-session';
const SESSION_ID = parseSessionId(sessionId);

/** What the saga raises when its rollback fails too: the trigger and the rollback failure. */
interface RaisedCompensation {
  cause?: Error;
  details: { rollbackError: Error & { cause?: Error } };
}

function messageItem(ulid: string): MessageRow {
  return {
    PK: sessionPartition(sessionId),
    SK: messageSortKey(ulid),
    sessionId,
    message: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array([1, 2, 3]),
    },
  };
}

/**
 * Real-AWS verification of the unrecoverable-compensation path. The append saga
 * runs against a real DynamoDB table: chunk 1's `TransactWriteItems` is a real
 * commit (the message and the `messageCount` ADD genuinely land). A thin client
 * wrapper then injects the two failures that do not occur naturally against
 * DynamoDB — the second chunk's transaction fails, and the rollback's
 * `BatchWriteItem` fails — so the code raises `COMPENSATION_FAILED`
 * and the partially-committed real state is left behind exactly as the error
 * warns. The committed state and the read-back are real DynamoDB; only the
 * failure points are injected.
 */
describe('append saga unrecoverable rollback against real AWS', () => {
  let admin: DynamoDBClient;
  let realDoc: DynamoDBDocument;
  let transactCalls = 0;

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  function wrappedContext(): HistoryContext {
    const client = {
      transactWrite: (input: Parameters<DynamoDBDocument['transactWrite']>[0]) => {
        transactCalls += 1;
        if (transactCalls === 1) return realDoc.transactWrite(input);
        return Promise.reject(
          Object.assign(new Error('chunk-2 transaction failed'), { name: 'ValidationException' }),
        );
      },
      batchWrite: () =>
        Promise.reject(
          Object.assign(new Error('rollback batch failed'), { name: 'ValidationException' }),
        ),
      update: (input: Parameters<DynamoDBDocument['update']>[0]) => realDoc.update(input),
    };
    return {
      client: client as unknown as DynamoDBDocument,
      tableName,
      serde: JSON_SERDE,
      logger,
      onCorruptMessage: 'skip' as const,
      ulid: () => 'unused',
    };
  }

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
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
    realDoc = DynamoDBDocument.from(admin);
  });

  afterAll(async () => {
    realDoc?.destroy();
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
  });

  it('raises COMPENSATION_FAILED and leaves the committed chunk in the real table', async () => {
    const chunks = [[messageItem('chunk1')], [messageItem('chunk2')]];

    await expect(
      appendChunks(wrappedContext(), { sessionId: SESSION_ID, chunks, fields: { now: 'now' } }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'DynamoDBLangGraphError',
        code: ErrorCode.COMPENSATION_FAILED,
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rollback failed'),
      expect.objectContaining({ sessionId }),
    );
  });

  it('preserves both the trigger cause and the rollback error', async () => {
    transactCalls = 0;
    const chunks = [[messageItem('again1')], [messageItem('again2')]];

    const error = (await appendChunks(wrappedContext(), {
      sessionId: SESSION_ID,
      chunks,
      fields: { now: 'now' },
    }).catch((caught: RaisedCompensation) => caught)) as RaisedCompensation;

    expect(error.cause?.message).toBe('chunk-2 transaction failed');
    // rollbackCommitted's batchWriteAll attempts every chunk and reports an
    // aggregate BATCH_WRITE_INCOMPLETE pass error rather than surfacing the raw
    // injected error. The chain is two levels deep, not one: the aggregate's
    // cause is the failing *chunk's* BATCH_WRITE_INCOMPLETE drain error, and the
    // raw error is that chunk error's own cause. This assertion previously
    // looked one level up and could never have matched.
    const rollbackError = error.details.rollbackError;
    expect(rollbackError).toMatchObject({
      code: ErrorCode.BATCH_WRITE_INCOMPLETE,
      details: { kind: 'pass' },
      cause: { code: ErrorCode.BATCH_WRITE_INCOMPLETE, details: { kind: 'drain' } },
    });
    expect((rollbackError.cause as Error & { cause?: Error }).cause?.message).toBe(
      'rollback batch failed',
    );
  });

  it('left the first chunk committed in real DynamoDB (the drift the error warns about)', async () => {
    const messages = await realDoc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
      ExpressionAttributeValues: {
        ':pk': sessionPartition(sessionId),
        ':m': messageSortKeyPrefix(),
      },
    });
    const committedSks = (messages.Items ?? []).map((item) => item.SK).sort();
    expect(committedSks).toEqual([messageSortKey('again1'), messageSortKey('chunk1')].sort());

    const meta = await realDoc.get({
      TableName: tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
      ConsistentRead: true,
    });
    expect(meta.Item?.messageCount).toBe(2);
  });
});
