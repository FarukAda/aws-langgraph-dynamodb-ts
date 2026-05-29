/**
 * CONTRACT tier — DynamoDBSaver vs. LangGraph's BaseCheckpointSaver (REQ-28 / AC-24).
 *
 * Proves our checkpointer satisfies the upstream `BaseCheckpointSaver` interface
 * shape AND behavior against the strict aws-sdk-client-mock (no real DynamoDB).
 * The assertions intentionally couple to the upstream abstract class: if a
 * LangGraph release renames/removes a required method or changes its arity, the
 * `typeof` + signature checks here fail. The round-trip block (put -> getTuple)
 * proves the implementation honors the contract's behavioral semantics, not just
 * its shape; an empty `list()` iteration proves the AsyncGenerator contract.
 *
 * Mock-backed only: the saver builds its own DynamoDBDocumentClient, which
 * mockClient(DynamoDBDocumentClient) intercepts at the command layer.
 */
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { BaseCheckpointSaver, type CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import {
  THREAD_ID,
  makeCheckpoint,
  makeCheckpointMetadata,
  makeRunnableConfig,
} from '../shared/fixtures/test-data';
import { expectNoUnexpectedCommands } from '../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../shared/mocks/dynamodb';

const CHECKPOINTS_TABLE = 'checkpoints-table';
const WRITES_TABLE = 'writes-table';
const CHECKPOINT_ID = 'ckpt-1';
const PAYLOAD_SK_PREFIX = 'PAYLOAD#';

function makeSaver(): DynamoDBSaver {
  return new DynamoDBSaver({
    checkpointsTableName: CHECKPOINTS_TABLE,
    writesTableName: WRITES_TABLE,
  });
}

describe('DynamoDBSaver conformance to BaseCheckpointSaver', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('is an instance of the upstream BaseCheckpointSaver and exposes a SerializerProtocol serde', () => {
    const saver = makeSaver();
    // Subclassing the upstream abstract class is the load-bearing contract: a
    // LangGraph change to the base class surfaces here.
    expect(saver).toBeInstanceOf(BaseCheckpointSaver);
    // The abstract base requires a `serde` SerializerProtocol with dumpsTyped/loadsTyped.
    expect(typeof saver.serde.dumpsTyped).toBe('function');
    expect(typeof saver.serde.loadsTyped).toBe('function');
  }); // AC-24

  it('implements the full abstract method set with the correct arities required by BaseCheckpointSaver', () => {
    const saver = makeSaver();
    // Required abstract members: getTuple/1, list/2, put/4, putWrites/3, deleteThread/1.
    expect(typeof saver.getTuple).toBe('function');
    expect(saver.getTuple.length).toBe(1);
    expect(typeof saver.list).toBe('function');
    expect(saver.list.length).toBe(2);
    expect(typeof saver.put).toBe('function');
    expect(saver.put.length).toBe(4);
    expect(typeof saver.putWrites).toBe('function');
    expect(saver.putWrites.length).toBe(3);
    expect(typeof saver.deleteThread).toBe('function');
    expect(saver.deleteThread.length).toBe(1);
    // Concrete inherited helper from the base must remain callable.
    expect(typeof saver.getNextVersion).toBe('function');
  }); // AC-24

  it('honors put -> getTuple round-trip semantics through the mock (returns a CheckpointTuple matching the stored config)', async () => {
    const config = makeRunnableConfig({ threadId: THREAD_ID });
    const checkpoint = makeCheckpoint({ id: CHECKPOINT_ID });
    const metadata = makeCheckpointMetadata();

    // put: one atomic TransactWrite (metadata + payload).
    ddb.mock.on(TransactWriteCommand).resolves({});
    const putResult = await makeSaver().put(config, checkpoint, metadata, {});

    // The returned config must carry the stored checkpoint_id per the contract.
    expect(putResult.configurable?.thread_id).toBe(THREAD_ID);
    expect(putResult.configurable?.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);

    // getTuple: metadata Get + payload Get + writes Query, all consistent reads.
    // The stored bytes must be VALID serde output (an empty Uint8Array would make
    // JSON.parse throw), so serialize the same checkpoint/metadata through the
    // saver's own SerializerProtocol and store exactly what put() would have.
    const serde = makeSaver().serde;
    const [checkpointType, checkpointBytes] = await serde.dumpsTyped(checkpoint);
    const [, metadataBytes] = await serde.dumpsTyped(metadata);

    ddb.reset();
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_ns: '',
          checkpoint_id: CHECKPOINT_ID,
          type: checkpointType,
          metadata: metadataBytes,
        },
      });
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
          checkpoint: checkpointBytes,
        },
      });
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    const tuple = (await makeSaver().getTuple(
      makeRunnableConfig({ threadId: THREAD_ID, checkpointId: CHECKPOINT_ID }),
    )) as CheckpointTuple;

    // The tuple must satisfy the upstream CheckpointTuple shape (config + checkpoint).
    expect(tuple).toBeDefined();
    expect(tuple.config.configurable?.thread_id).toBe(THREAD_ID);
    expect(tuple.config.configurable?.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(tuple.checkpoint).toBeDefined();
    expect(Array.isArray(tuple.pendingWrites)).toBe(true);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, QueryCommand]);
  }); // AC-24

  it('getTuple resolves to undefined for an absent checkpoint, honoring the optional CheckpointTuple contract', async () => {
    ddb.mock.on(GetCommand).resolves({ Item: undefined });
    const tuple = await makeSaver().getTuple(
      makeRunnableConfig({ threadId: THREAD_ID, checkpointId: CHECKPOINT_ID }),
    );
    expect(tuple).toBeUndefined();
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  }); // AC-24

  it('list() returns a conformant AsyncGenerator that yields zero CheckpointTuples for an empty thread', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    const iterator = makeSaver().list(makeRunnableConfig({ threadId: THREAD_ID }), undefined);
    // The AsyncGenerator protocol (Symbol.asyncIterator + next) is part of the contract.
    expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
    const collected: CheckpointTuple[] = [];
    for await (const tuple of iterator) {
      collected.push(tuple);
    }
    expect(collected).toEqual([]);
  }); // AC-24

  it('list() rejects a non-string thread_id with the documented message before any DDB call (contract negative)', async () => {
    const iterator = makeSaver().list({ configurable: { thread_id: 42 } }, undefined);
    await expect(iterator.next()).rejects.toThrow('thread_id must be a string');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-24
});
