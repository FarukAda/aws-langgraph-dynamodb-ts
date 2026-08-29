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

  it('does not double-decrement the session count when the rollback revert transaction is retried after a lost response', async () => {
    const base = new DynamoDBClient(DDB_LOCAL_CONFIG);
    let transactionCalls = 0;
    let revertAttempts = 0;
    base.middlewareStack.add(
      (next, context) => async (args) => {
        const commandName = (context as { commandName?: string }).commandName ?? '';
        if (commandName !== 'TransactWriteItemsCommand') return next(args);
        const input = (
          args as {
            input: {
              TransactItems?: { Update?: { UpdateExpression?: string }; Delete?: object }[];
            };
          }
        ).input;
        const items = input.TransactItems ?? [];
        /**
         * The compensating transaction is either the conditional delete of a
         * session this call created (C4) or the count decrement it falls back
         * to. Both carry a ClientRequestToken and both must survive a lost
         * response, so match either shape.
         */
        const isRevert =
          items.length === 1 &&
          (items[0]?.Update?.UpdateExpression === 'ADD #count :neg' ||
            items[0]?.Delete !== undefined);
        if (isRevert) {
          revertAttempts += 1;
          if (revertAttempts === 1) {
            await next(args);
            throw Object.assign(new Error('simulated lost response on revert'), {
              name: 'ServiceUnavailable',
            });
          }
          return next(args);
        }
        transactionCalls += 1;
        if (transactionCalls === 2) {
          throw Object.assign(new Error('injected chunk-2 failure'), {
            name: 'ValidationException',
          });
        }
        return next(args);
      },
      { step: 'initialize', name: 'revertIdempotencyInjector', priority: 'high' },
    );
    const faulted = new DynamoDBChatMessageHistory({
      tableName,
      client: DynamoDBDocument.from(base),
    });

    const sessionId = 's-revert-idem';
    const messages = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));
    await expect(faulted.addMessages(sessionId, messages)).rejects.toThrow('injected chunk-2');
    base.destroy();

    // The revert's own transaction was attempted twice: the first "commits
    // server-side but the client sees a lost response", the retry with the
    // same ClientRequestToken must be deduped by DynamoDB, not re-applied.
    expect(revertAttempts).toBe(2);

    const stored = await reader.getMessages(sessionId);
    expect(stored).toHaveLength(0);
    const sessions = await reader.listSessions();
    const meta = sessions.find((session) => session.sessionId === sessionId);
    // Pre-fix (a bare, non-idempotent UpdateItem retried on the same
    // lost-response path) this could go negative from double-applying the -99
    // decrement. Since C4 the row this call created is removed outright, so
    // "no session, or a session at zero" are both correct outcomes here.
    expect(meta?.messageCount ?? 0).toBe(0);
  });

  it('attempts every batch-write chunk during rollback even when one chunk fails partway through', async () => {
    const base = new DynamoDBClient(DDB_LOCAL_CONFIG);
    installFaults(base, [
      {
        match: (name) => name === 'TransactWriteItemsCommand',
        fail: () => awsError('ValidationException', 'injected chunk-2 failure'),
        skip: 1,
        times: 1,
      },
      {
        match: (name) => name === 'BatchWriteItemCommand',
        fail: () => awsError('ValidationException', 'injected batch-3 failure'),
        skip: 2,
        times: 1,
      },
    ]);
    const faulted = new DynamoDBChatMessageHistory({
      tableName,
      client: DynamoDBDocument.from(base),
    });

    const sessionId = 's-multi-chunk-rollback';
    const messages = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));
    await expect(faulted.addMessages(sessionId, messages)).rejects.toMatchObject({
      name: 'CompensationFailedError',
    });
    base.destroy();

    // Chunk 1's 99 rows split into 4 BatchWriteItem deletes (25+25+25+24) during
    // rollback. The 3rd delete-batch is injected to fail. Pre-fix, batchWriteAll
    // aborted on the first failing batch, leaving every batch after it
    // unattempted (49 rows would survive: batch 3's 25 + batch 4's 24). Post-fix
    // it attempts every batch regardless, so only batch 3's ~25 rows survive.
    const remaining = await reader.getMessages(sessionId);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThanOrEqual(25);
  });
});
