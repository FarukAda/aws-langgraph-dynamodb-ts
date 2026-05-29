/**
 * Unit tests for addMessageAction (src/history/actions/add-message.ts).
 *
 * addMessageAction is a thin wrapper that delegates to addMessagesAction with a
 * 1-element array. These tests assert the exact GetCommand + TransactWriteCommand
 * shapes the wrapper produces (mirroring AC-11's #ttl lock) and the validation
 * negative path.
 */
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { addMessageAction } from '../../../../src/history/actions/add-message';
import { makeBaseMessage, USER_ID, SESSION_ID } from '../../../shared/fixtures/test-data';
import { FROZEN_NOW_MS, EXPECTED_TTL_30D } from '../../../shared/helpers/frozen-time';
import {
  expectExactGetCommand,
  expectExactTransactWriteCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const TABLE = 'history-table';

const EXPECTED_GET_INPUT = {
  TableName: TABLE,
  Key: { userId: USER_ID, sessionId: SESSION_ID },
  ConsistentRead: true,
  ProjectionExpression: 'messageCount',
};

describe('addMessageAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('writes a single-message Put + metadata Update transaction for a new session', async () => {
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});

    const message = makeBaseMessage({ role: 'human', content: 'hi there' });

    await addMessageAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      message,
    });

    expectExactGetCommand(ddb.mock, EXPECTED_GET_INPUT);
    expectExactTransactWriteCommand(ddb.mock, {
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              userId: USER_ID,
              sessionId: `${SESSION_ID}#msg#000000`,
              itemType: 'message',
              messageIndex: 0,
              message: message.toDict(),
            },
          },
        },
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
              ':title': 'hi there',
            },
          },
        },
      ],
    });
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
  }); // AC-11

  it('threads ExpressionAttributeNames {#ttl:ttl} and the exact 30-day TTL into the Update when ttlDays is set', async () => {
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});

    const message = makeBaseMessage({ role: 'human', content: 'hi there' });

    await addMessageAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      sessionId: SESSION_ID,
      message,
      title: 'Pinned Title',
      ttlDays: 30,
    });

    expectExactTransactWriteCommand(ddb.mock, {
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              userId: USER_ID,
              sessionId: `${SESSION_ID}#msg#000000`,
              itemType: 'message',
              messageIndex: 0,
              message: message.toDict(),
              ttl: EXPECTED_TTL_30D,
            },
          },
        },
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
              ':title': 'Pinned Title',
              ':ttl': EXPECTED_TTL_30D,
            },
            ExpressionAttributeNames: { '#ttl': 'ttl' },
          },
        },
      ],
    });
  }); // AC-11

  it('throws HistoryValidationError and issues zero DDB commands when userId is empty', async () => {
    await expect(
      addMessageAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: '',
        sessionId: SESSION_ID,
        message: makeBaseMessage(),
      }),
    ).rejects.toThrow('User ID cannot be empty');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17
});
