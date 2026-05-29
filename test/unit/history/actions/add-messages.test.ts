/**
 * Unit tests for addMessagesAction (src/history/actions/add-messages.ts).
 *
 * Characterization tests: assert the EXACT GetCommand + TransactWriteCommand
 * shapes the source produces, including the locked #ttl aliasing (AC-10/AC-11),
 * the optimistic-concurrency retry on ConditionalCheckFailedException, and the
 * documented error / abort paths (AC-18).
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { addMessagesAction } from '../../../../src/history/actions/add-messages';
import { makeMessages, USER_ID, SESSION_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { FROZEN_NOW_MS, EXPECTED_TTL_30D } from '../../../shared/helpers/frozen-time';
import {
  expectExactGetCommand,
  expectExactTransactWriteCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const TABLE = 'history-table';

// The single-message fixture used across the file. content === 'message-0',
// so the auto-generated title (generateTitle) is exactly 'message-0'.
function oneMessage() {
  return makeMessages(1);
}

// The GetCommand input the source builds for the read-before-write step.
const EXPECTED_GET_INPUT = {
  TableName: TABLE,
  Key: { userId: USER_ID, sessionId: SESSION_ID },
  ConsistentRead: true,
  ProjectionExpression: 'messageCount',
};

describe('addMessagesAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('writes the message Put + metadata Update transaction for a brand-new session (no ttl)', async () => {
    ddb.mock.on(GetCommand).resolves({}); // new session: no Item
    ddb.mock.on(TransactWriteCommand).resolves({});

    await addMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      messages: oneMessage(),
    });

    expectExactGetCommand(ddb.mock, EXPECTED_GET_INPUT);

    const storedMessage = oneMessage();
    const messageItem = {
      userId: USER_ID,
      sessionId: `${SESSION_ID}#msg#000000`,
      itemType: 'message',
      messageIndex: 0,
      message: storedMessage[0].toDict(),
    };

    expectExactTransactWriteCommand(ddb.mock, {
      TransactItems: [
        { Put: { TableName: TABLE, Item: messageItem } },
        {
          Update: {
            TableName: TABLE,
            Key: { userId: USER_ID, sessionId: SESSION_ID },
            UpdateExpression:
              'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt)',
            ConditionExpression: 'attribute_not_exists(messageCount)',
            ExpressionAttributeValues: {
              ':updatedAt': FROZEN_NOW_MS,
              ':createdAt': FROZEN_NOW_MS,
              ':newCount': 1,
              ':itemType': 'metadata',
              ':title': 'message-0',
            },
          },
        },
      ],
    });

    expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
  }); // AC-11

  it('threads ExpressionAttributeNames {#ttl:ttl} and stamps per-message + metadata TTL when ttlDays is set', async () => {
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});

    await addMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      messages: oneMessage(),
      ttlDays: 30,
    });

    const storedMessage = oneMessage();
    const messageItem = {
      userId: USER_ID,
      sessionId: `${SESSION_ID}#msg#000000`,
      itemType: 'message',
      messageIndex: 0,
      message: storedMessage[0].toDict(),
      ttl: EXPECTED_TTL_30D,
    };

    expectExactTransactWriteCommand(ddb.mock, {
      TransactItems: [
        { Put: { TableName: TABLE, Item: messageItem } },
        {
          Update: {
            TableName: TABLE,
            Key: { userId: USER_ID, sessionId: SESSION_ID },
            UpdateExpression:
              'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt), #ttl = :ttl',
            ConditionExpression: 'attribute_not_exists(messageCount)',
            ExpressionAttributeValues: {
              ':updatedAt': FROZEN_NOW_MS,
              ':createdAt': FROZEN_NOW_MS,
              ':newCount': 1,
              ':itemType': 'metadata',
              ':title': 'message-0',
              ':ttl': EXPECTED_TTL_30D,
            },
            ExpressionAttributeNames: { '#ttl': 'ttl' },
          },
        },
      ],
    });
  }); // AC-11

  it('uses messageCount = :expectedCount condition and appends at the existing index for an existing session', async () => {
    ddb.mock.on(GetCommand).resolves({ Item: { messageCount: 2 } });
    ddb.mock.on(TransactWriteCommand).resolves({});

    await addMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      messages: oneMessage(),
    });

    const storedMessage = oneMessage();
    expectExactTransactWriteCommand(ddb.mock, {
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              userId: USER_ID,
              sessionId: `${SESSION_ID}#msg#000002`,
              itemType: 'message',
              messageIndex: 2,
              message: storedMessage[0].toDict(),
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { userId: USER_ID, sessionId: SESSION_ID },
            UpdateExpression:
              'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt)',
            ConditionExpression: 'messageCount = :expectedCount',
            ExpressionAttributeValues: {
              ':updatedAt': FROZEN_NOW_MS,
              ':createdAt': FROZEN_NOW_MS,
              ':newCount': 3,
              ':itemType': 'metadata',
              ':title': 'message-0',
              ':expectedCount': 2,
            },
          },
        },
      ],
    });
  }); // AC-11

  it('retries the read+transaction once on ConditionalCheckFailedException then succeeds', async () => {
    // First transaction loses the optimistic race; second wins.
    ddb.mock.on(GetCommand).resolves({ Item: { messageCount: 0 } });
    ddb.mock
      .on(TransactWriteCommand)
      .rejectsOnce(new ConditionalCheckFailedException({ message: 'race', $metadata: {} }))
      .resolves({});

    await addMessagesAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      messages: oneMessage(),
    });

    // Re-read on retry: two GetCommands, two TransactWriteCommands.
    expect(ddb.mock.commandCalls(GetCommand)).toHaveLength(2);
    expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
  }); // AC-18

  it('throws HistoryValidationError and issues zero DDB commands on an empty messages array', async () => {
    await expect(
      addMessagesAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        sessionId: SESSION_ID,
        messages: [],
      }),
    ).rejects.toThrow('Messages array cannot be empty');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  it('rejects with the abort reason and issues zero DDB commands when the signal is already aborted', async () => {
    const reason = new Error('cancelled-add-messages');
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});

    await expect(
      addMessagesAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        sessionId: SESSION_ID,
        messages: oneMessage(),
        signal: preAbortedSignal(reason),
      }),
    ).rejects.toBe(reason);

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18
});
