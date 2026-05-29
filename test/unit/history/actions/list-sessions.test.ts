/**
 * Unit tests for listSessionsAction (src/history/actions/list-sessions.ts).
 *
 * Asserts the exact QueryCommand (metadata FilterExpression + projection),
 * client-side updatedAt-DESC sort, the limit slice, and the documented
 * validation / abort paths (AC-18).
 */
import { ThrottlingException } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { listSessionsAction } from '../../../../src/history/actions/list-sessions';
import { USER_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const TABLE = 'history-table';

const EXPECTED_QUERY_INPUT = {
  TableName: TABLE,
  KeyConditionExpression: 'userId = :userId',
  FilterExpression: 'itemType = :metadata',
  ExpressionAttributeValues: {
    ':userId': USER_ID,
    ':metadata': 'metadata',
  },
  ProjectionExpression: 'sessionId, title, createdAt, updatedAt, messageCount',
  ExclusiveStartKey: undefined,
};

function metadataItem(sessionId: string, updatedAt: number) {
  return {
    sessionId,
    title: `title-${sessionId}`,
    createdAt: 1_000,
    updatedAt,
    messageCount: 2,
  };
}

describe('listSessionsAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('queries metadata items and returns them sorted by updatedAt descending', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [metadataItem('s-old', 100), metadataItem('s-new', 300), metadataItem('s-mid', 200)],
    });

    const result = await listSessionsAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
    });

    expectExactQueryCommand(ddb.mock, EXPECTED_QUERY_INPUT);
    expect(result.map((s) => s.sessionId)).toEqual(['s-new', 's-mid', 's-old']);
    expect(result[0]).toEqual({
      sessionId: 's-new',
      title: 'title-s-new',
      createdAt: 1_000,
      updatedAt: 300,
      messageCount: 2,
    });
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-7

  it('slices the sorted result down to the requested limit', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [metadataItem('s-old', 100), metadataItem('s-new', 300), metadataItem('s-mid', 200)],
    });

    const result = await listSessionsAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
      limit: 2,
    });

    expect(result.map((s) => s.sessionId)).toEqual(['s-new', 's-mid']);
  }); // AC-7

  it('returns an empty array and issues exactly one query when the user has no sessions', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    const result = await listSessionsAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
    });

    expect(result).toEqual([]);
    expectExactQueryCommand(ddb.mock, EXPECTED_QUERY_INPUT);
  }); // AC-7

  it('throws HistoryValidationError and issues zero DDB commands when limit is zero', async () => {
    await expect(
      listSessionsAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        limit: 0,
      }),
    ).rejects.toThrow('Limit must be positive');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('surfaces a throttling error after exhausting the five DynamoDB retry attempts', async () => {
    ddb.mock
      .on(QueryCommand)
      .rejects(new ThrottlingException({ message: 'slow down', $metadata: {} }));

    const promise = listSessionsAction({
      client: ddb.mock as never,
      tableName: TABLE,
      userId: USER_ID,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ThrottlingException);
    // Drive the fake-timer backoff sleeps between retry attempts to completion.
    await jest.runAllTimersAsync();
    await assertion;

    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(5);
  }); // AC-18

  it('rejects with the abort reason and issues zero DDB commands when the signal is already aborted', async () => {
    const reason = new Error('cancelled-list-sessions');
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      listSessionsAction({
        client: ddb.mock as never,
        tableName: TABLE,
        userId: USER_ID,
        signal: preAbortedSignal(reason),
      }),
    ).rejects.toBe(reason);

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18
});
