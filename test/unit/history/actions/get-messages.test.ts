/**
 * Unit tests for getMessagesAction (src/history/actions/get-messages.ts).
 *
 * Asserts the exact QueryCommand shape (SK-prefix KeyCondition), chronological
 * ordering by messageIndex, deserialization back to BaseMessage instances, and
 * the documented error / abort paths (AC-18).
 */
import { ProvisionedThroughputExceededException } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, AIMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessagesAction } from '../../../../src/history/actions/get-messages';
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
  ExclusiveStartKey: undefined,
};

/** A stored DynamoDBMessageItem for the given index + message. */
function storedItem(index: number, message: HumanMessage | AIMessage) {
  const [stored] = mapChatMessagesToStoredMessages([message]);
  return {
    userId: USER_ID,
    sessionId: `${SESSION_ID}#msg#${String(index).padStart(6, '0')}`,
    itemType: 'message',
    messageIndex: index,
    message: stored,
  };
}

describe('getMessagesAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('queries by SK prefix and returns messages deserialized in messageIndex order', async () => {
    // Returned out of order to prove the action sorts by messageIndex.
    ddb.mock.on(QueryCommand).resolves({
      Items: [storedItem(1, new AIMessage('second')), storedItem(0, new HumanMessage('first'))],
    });

    const result = await getMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expectExactQueryCommand(ddb.mock, EXPECTED_QUERY_INPUT);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('first');
    expect(result[1].content).toBe('second');
    expect(result[0]).toBeInstanceOf(HumanMessage);
    expect(result[1]).toBeInstanceOf(AIMessage);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-7

  it('returns an empty array and issues exactly one query when the session has no messages', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    const result = await getMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(result).toEqual([]);
    expectExactQueryCommand(ddb.mock, EXPECTED_QUERY_INPUT);
  }); // AC-7

  it('throws HistoryValidationError and issues zero DDB commands when sessionId contains "#"', async () => {
    await expect(
      getMessagesAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        sessionId: 'bad#session',
      }),
    ).rejects.toThrow('Session ID cannot contain "#" character');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('surfaces a throttling error after exhausting the five DynamoDB retry attempts', async () => {
    // ProvisionedThroughputExceededException is retryable: 5 attempts then surfaced.
    ddb.mock
      .on(QueryCommand)
      .rejects(new ProvisionedThroughputExceededException({ message: 'throttled', $metadata: {} }));

    const promise = getMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ProvisionedThroughputExceededException,
    );
    // Drive the fake-timer backoff sleeps between retry attempts to completion.
    await jest.runAllTimersAsync();
    await assertion;

    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(5);
  }); // AC-18

  it('rejects with the abort reason and issues zero DDB commands when the signal is already aborted', async () => {
    const reason = new Error('cancelled-get-messages');
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      getMessagesAction({
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
