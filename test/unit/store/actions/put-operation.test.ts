/**
 * Unit tests for src/store/actions/put-operation.ts.
 *
 * Characterizes the EXISTING putOperationAction. Locks:
 *  - the exact UpdateCommand shape (TableName, Key, UpdateExpression,
 *    ExpressionAttributeNames, ExpressionAttributeValues) via .toEqual()
 *  - the #ttl reserved-word aliasing: EAN contains { '#ttl': 'ttl' } when ttlDays
 *    is set and the '#ttl' key is ABSENT when not (AC-12 / REQ-16)
 *  - the value===null delete path (DeleteCommand)
 *  - embedding edge cases at unit level (gap-class N / AC-31): empty input array
 *    issues no embed call; null/short vectors; NaN entries rejected
 *  - AbortSignal behavior (AC-18)
 *  - the injected-clock seam (AC-38 / REQ-45) — depends on a not-yet-added
 *    PutOperationActionParams.now? field and so may fail to compile until the
 *    seam ships; that is the expected test-author handoff state.
 *
 * Frozen time freezes Date.now()/calculateTTLTimestamp to FROZEN_NOW_MS so all
 * deterministic values are pinned to constants (no expect.any).
 */
import { DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { putOperationAction } from '../../../../src/store/actions';
import { USER_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { EXPECTED_TTL_30D, FROZEN_NOW_MS } from '../../../shared/helpers/frozen-time';
import {
  expectExactDeleteCommand,
  expectExactUpdateCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';
import {
  embeddingReturnsNaN,
  makeEmbeddingMock,
  recordingEmbeddingMock,
} from '../../../shared/mocks/embedding';

const MEMORY_TABLE = 'memory-table';
const NS = ['ns'];
const KEY = 'key1';
const SORT_KEY = 'ns#key1';
const VALUE = { data: 'value' };

const BASE_UPDATE_EXPRESSION =
  'SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt' +
  ', createdAt = if_not_exists(createdAt, :createdAt)';

describe('putOperationAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  const client = (): DynamoDBDocument => ddb.mock as unknown as DynamoDBDocument;

  it('issues an UpdateCommand with the exact base shape and NO #ttl when ttlDays is unset', async () => {
    ddb.mock.on(UpdateCommand).resolves({});

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY, value: VALUE },
    });

    expectExactUpdateCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      Key: { user_id: USER_ID, namespace_key: SORT_KEY },
      UpdateExpression: BASE_UPDATE_EXPRESSION,
      ExpressionAttributeNames: { '#key': 'key', '#value': 'value' },
      ExpressionAttributeValues: {
        ':namespace': 'ns',
        ':key': KEY,
        ':value': VALUE,
        ':updatedAt': FROZEN_NOW_MS,
        ':createdAt': FROZEN_NOW_MS,
      },
    });
    // EAN must NOT carry the #ttl alias when ttlDays is unset.
    const call = ddb.mock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeNames).not.toHaveProperty('#ttl');
    expectNoUnexpectedCommands(ddb.mock, [UpdateCommand]);
  }); // AC-12

  it('aliases #ttl and pins :ttl to EXPECTED_TTL_30D when ttlDays is set', async () => {
    ddb.mock.on(UpdateCommand).resolves({});

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY, value: VALUE },
      ttlDays: 30,
    });

    expectExactUpdateCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      Key: { user_id: USER_ID, namespace_key: SORT_KEY },
      UpdateExpression:
        'SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt' +
        ', #ttl = :ttl' +
        ', createdAt = if_not_exists(createdAt, :createdAt)',
      ExpressionAttributeNames: { '#key': 'key', '#value': 'value', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':namespace': 'ns',
        ':key': KEY,
        ':value': VALUE,
        ':updatedAt': FROZEN_NOW_MS,
        ':createdAt': FROZEN_NOW_MS,
        ':ttl': EXPECTED_TTL_30D,
      },
    });
  }); // AC-12

  it('routes value===null through a DeleteCommand with the composite Key and writes no item', async () => {
    ddb.mock.on(DeleteCommand).resolves({});

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,

      op: { namespace: NS, key: KEY, value: null as any },
    });

    expectExactDeleteCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      Key: { user_id: USER_ID, namespace_key: SORT_KEY },
    });
    expectNoUnexpectedCommands(ddb.mock, [DeleteCommand]);
  }); // AC-7

  it('adds the embedding attribute to the UpdateCommand when an embedding + index are provided', async () => {
    ddb.mock.on(UpdateCommand).resolves({});
    const embedding = makeEmbeddingMock({ dimensions: 4 });

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY, value: { text: 'hello' }, index: ['$.text'] },
      embedding,
    });

    const call = ddb.mock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.UpdateExpression).toContain('embedding = :embedding');
    expect(call.args[0].input.ExpressionAttributeValues).toHaveProperty(':embedding');
    const embeddingValue = call.args[0].input.ExpressionAttributeValues![':embedding'];
    expect(Array.isArray(embeddingValue)).toBe(true);
    expect((embeddingValue as number[][])[0]).toHaveLength(4);
  }); // AC-31

  it('issues no embedDocuments call when the index resolves to an empty input array', async () => {
    ddb.mock.on(UpdateCommand).resolves({});
    const embedding = recordingEmbeddingMock();

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      // value has no `text` field, so JSONPath yields nothing to embed
      op: { namespace: NS, key: KEY, value: { other: 'x' }, index: ['$.text'] },
      embedding,
    });

    expect(embedding.callCount).toBe(0);
    const call = ddb.mock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues).not.toHaveProperty(':embedding');
  }); // AC-31

  it('rejects via validateEmbeddings when embedDocuments returns NaN vector entries and writes nothing', async () => {
    const embedding = embeddingReturnsNaN();

    await expect(
      putOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: KEY, value: { text: 'hello' }, index: ['$.text'] },
        embedding,
      }),
    ).rejects.toThrow('Embedding values must be finite numbers');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-31

  it('rejects with the value ValidationError and writes nothing when value is undefined', async () => {
    await expect(
      putOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,

        op: { namespace: NS, key: KEY, value: undefined as any },
      }),
    ).rejects.toThrow('Value cannot be undefined');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('propagates a non-retryable ConditionalCheckFailedException from the UpdateCommand', async () => {
    const err = Object.assign(new Error('condition failed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddb.mock.on(UpdateCommand).rejects(err);

    await expect(
      putOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: KEY, value: VALUE },
      }),
    ).rejects.toThrow('condition failed');
    expectNoUnexpectedCommands(ddb.mock, [UpdateCommand]);
  }); // AC-8

  it('short-circuits with zero DDB calls when the signal is already aborted', async () => {
    const reason = new Error('already-aborted');
    const signal = preAbortedSignal(reason);

    await expect(
      putOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespace: NS, key: KEY, value: VALUE },
        signal,
      }),
    ).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  it('uses the injected clock seam for :updatedAt/:createdAt instead of Date.now (default stays Date.now)', async () => {
    ddb.mock.on(UpdateCommand).resolves({});
    const FIXED = 2_000_000_000_000;

    await putOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespace: NS, key: KEY, value: VALUE },
      // Seam (REQ-45): PutOperationActionParams gains optional now?.
      now: () => FIXED,
    });

    const call = ddb.mock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':updatedAt']).toBe(FIXED);
    expect(call.args[0].input.ExpressionAttributeValues![':createdAt']).toBe(FIXED);
  }); // AC-38
});
