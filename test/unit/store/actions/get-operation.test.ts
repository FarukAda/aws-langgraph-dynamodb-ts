/**
 * Unit tests for src/store/actions/get-operation.ts.
 *
 * Characterizes the EXISTING getOperationAction. Asserts the exact GetCommand
 * class and full `.input` shape (TableName + Key) via .toEqual(), the
 * not-found (null) branch, validation negatives, and AbortSignal behavior.
 *
 * Strict DDB mock (rejects un-stubbed commands), frozen time, pinned constants.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { getOperationAction } from '../../../../src/store/actions';
import { USER_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import {
  expectExactGetCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const MEMORY_TABLE = 'memory-table';
const NS = ['ns', 'sub'];
const KEY = 'key1';
// namespace_key === `${namespace.join('/')}#${key}`
const SORT_KEY = 'ns/sub#key1';

describe('getOperationAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  // The action receives a real DynamoDBDocument that the aws-sdk-client-mock
  // intercepts at the command layer. The cast narrows the mock to the param type.
  const client = (): DynamoDBDocument => ddb.mock as unknown as DynamoDBDocument;

  it('issues a GetCommand with exact TableName and composite Key and maps a found item', async () => {
    ddb.mock.on(GetCommand).resolves({
      Item: {
        key: KEY,
        value: { data: 'v' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_500_000,
      },
    });

    const result = await getOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY },
    });

    expectExactGetCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      Key: { user_id: USER_ID, namespace_key: SORT_KEY },
    });
    expect(result).toEqual({
      key: KEY,
      namespace: NS,
      value: { data: 'v' },
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_500_000),
    });
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  }); // AC-7

  it('returns null when DynamoDB returns no Item (not-found branch)', async () => {
    ddb.mock.on(GetCommand).resolves({});

    const result = await getOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY },
    });

    expect(result).toBeNull();
    expectExactGetCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      Key: { user_id: USER_ID, namespace_key: SORT_KEY },
    });
  }); // AC-7

  it('rejects with the ValidationError message and issues no GetCommand for an empty userId', async () => {
    await expect(
      getOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: '',
        op: { namespace: NS, key: KEY },
      }),
    ).rejects.toThrow('User ID cannot be empty');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('rejects with the namespace ValidationError and issues no GetCommand for an empty namespace', async () => {
    await expect(
      getOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: [], key: KEY },
      }),
    ).rejects.toThrow('Namespace cannot be empty');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('rejects with the key ValidationError when the key contains a "#" separator', async () => {
    await expect(
      getOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: 'bad#key' },
      }),
    ).rejects.toThrow('Key cannot contain "#" character');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('propagates a non-retryable ResourceNotFoundException from the GetCommand', async () => {
    const err = Object.assign(new Error('table missing'), {
      name: 'ResourceNotFoundException',
    });
    ddb.mock.on(GetCommand).rejects(err);

    await expect(
      getOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: KEY },
      }),
    ).rejects.toThrow('table missing');
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  }); // AC-8

  it('short-circuits with zero DDB calls when the signal is already aborted', async () => {
    const reason = new Error('already-aborted');
    const signal = preAbortedSignal(reason);

    await expect(
      getOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: KEY },
        signal,
      }),
    ).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18
});
