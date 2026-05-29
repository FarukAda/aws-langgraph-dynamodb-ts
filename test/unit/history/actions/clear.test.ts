/**
 * Unit tests for clearAction (src/history/actions/clear.ts).
 *
 * Asserts the exact QueryCommand (SK-prefix scan with projection) and the
 * resulting BatchWriteCommand (metadata key first, then message keys), plus the
 * documented error / abort paths (AC-18).
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { clearAction } from '../../../../src/history/actions/clear';
import { USER_ID, SESSION_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const TABLE = 'history-table';

const EXPECTED_QUERY_INPUT = {
  TableName: TABLE,
  KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
  ExpressionAttributeValues: {
    ':userId': USER_ID,
    ':prefix': `${SESSION_ID}#msg#`,
  },
  ProjectionExpression: 'userId, sessionId',
  ExclusiveStartKey: undefined,
};

describe('clearAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('queries message keys then batch-deletes the metadata key first followed by each message key', async () => {
    const msgKey0 = { userId: USER_ID, sessionId: `${SESSION_ID}#msg#000000` };
    const msgKey1 = { userId: USER_ID, sessionId: `${SESSION_ID}#msg#000001` };
    ddb.mock.on(QueryCommand).resolves({ Items: [msgKey0, msgKey1] });
    ddb.mock.on(BatchWriteCommand).resolves({});

    await clearAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expectExactQueryCommand(ddb.mock, EXPECTED_QUERY_INPUT);

    const batchCalls = ddb.mock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args[0].input).toEqual({
      RequestItems: {
        [TABLE]: [
          { DeleteRequest: { Key: { userId: USER_ID, sessionId: SESSION_ID } } },
          { DeleteRequest: { Key: msgKey0 } },
          { DeleteRequest: { Key: msgKey1 } },
        ],
      },
    });
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchWriteCommand]);
  }); // AC-7

  it('deletes only the metadata key when the session has no message items', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [] });
    ddb.mock.on(BatchWriteCommand).resolves({});

    await clearAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const batchCalls = ddb.mock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args[0].input).toEqual({
      RequestItems: {
        [TABLE]: [{ DeleteRequest: { Key: { userId: USER_ID, sessionId: SESSION_ID } } }],
      },
    });
  }); // AC-7

  it('throws HistoryValidationError and issues zero DDB commands when userId is not a string', async () => {
    await expect(
      clearAction({
        client: ddb.mock as never,
        tableName: TABLE,

        userId: 123 as any,
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow('User ID must be a string');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('surfaces a non-retryable error (ConditionalCheckFailed) from the query without deleting anything', async () => {
    ddb.mock
      .on(QueryCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'nope', $metadata: {} }));
    ddb.mock.on(BatchWriteCommand).resolves({});

    await expect(
      clearAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);

    // Non-retryable: a single query attempt, no batch delete.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  }); // AC-18

  it('rejects with the abort reason and issues zero DDB commands when the signal is already aborted', async () => {
    const reason = new Error('cancelled-clear');
    ddb.mock.on(QueryCommand).resolves({ Items: [] });
    ddb.mock.on(BatchWriteCommand).resolves({});

    await expect(
      clearAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        sessionId: SESSION_ID,
        signal: preAbortedSignal(reason),
      }),
    ).rejects.toBe(reason);

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18
});
