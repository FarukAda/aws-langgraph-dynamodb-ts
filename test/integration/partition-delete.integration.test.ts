import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBChatMessageHistory, DynamoDBSaver } from '../../src/index';
import type { Logger } from '../../src/shared/logging/logger';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { afterResponse } from './helpers/fault-injection';
import { MemoryS3 } from './helpers/memory-s3';
import { referencedS3Keys } from './helpers/referenced-keys';

const tableName = 'partition-delete-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const reader = DynamoDBDocument.from(admin);
const s3 = new MemoryS3();
/** Every payload offloads, so whether a row's object was released is observable. */
const offload = { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => s3 };
const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

let saver: DynamoDBSaver;
let history: DynamoDBChatMessageHistory;
const warnings: string[] = [];
const collecting: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => {
    warnings.push(message);
  },
  error: () => {},
};

beforeAll(async () => {
  await createTable(admin, tableName);
  saver = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG, s3: offload });
  history = new DynamoDBChatMessageHistory({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    s3: offload,
  });
});

afterAll(async () => {
  saver.destroy();
  history.destroy();
  /**
   * The adapters below are built on clients this file owns, and `destroy()` on
   * an adapter deliberately leaves a caller-supplied client alone. Without this
   * the run ends with live keep-alive agents and jest reports a worker that
   * failed to exit, long after the last assertion passed.
   */
  for (const base of racingClients) base.destroy();
  racingClients.length = 0;
  await deleteTable(admin, tableName);
  admin.destroy();
});

beforeEach(() => {
  warnings.length = 0;
});

function checkpoint(id: string, marker: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { blob: `${marker}-${'x'.repeat(512)}` },
    channel_versions: { blob: 1 },
    versions_seen: {},
  };
}

const threadConfig = (threadId: string, checkpointId?: string) => ({
  configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId },
});

/** Every client this file builds for a racing writer, destroyed in `afterAll`. */
const racingClients: DynamoDBClient[] = [];

/**
 * A saver whose partition read is interrupted, once, by `race` — so a write
 * lands after the read observed the partition and before any delete is issued,
 * which is exactly the window the pin exists to close.
 */
function racingSaver(race: () => Promise<void>, withS3 = true): DynamoDBSaver {
  const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
  racingClients.push(base);
  afterResponse(base, 'QueryCommand', race);
  return new DynamoDBSaver({
    tableName,
    client: DynamoDBDocument.from(base),
    logger: collecting,
    ...(withS3 ? { s3: offload } : {}),
  });
}

/** The same, for a chat-history session. */
function racingHistory(race: () => Promise<void>): DynamoDBChatMessageHistory {
  const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
  racingClients.push(base);
  afterResponse(base, 'QueryCommand', race);
  return new DynamoDBChatMessageHistory({
    tableName,
    client: DynamoDBDocument.from(base),
    logger: collecting,
    s3: offload,
  });
}

/** Objects a live row still names that are no longer in the bucket. */
async function missingObjects(): Promise<string[]> {
  const referenced = await referencedS3Keys(reader, tableName);
  const stored = s3.keys();
  return referenced.filter((key) => !stored.includes(key));
}

/** The sort keys still in one partition, read strongly-consistently. */
async function sortKeysIn(partitionKey: string): Promise<string[]> {
  const page = await reader.query({
    TableName: tableName,
    ConsistentRead: true,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'PK' },
    ExpressionAttributeValues: { ':pk': partitionKey },
  });
  return (page.Items ?? []).map((row) => row.SK as string);
}

describe('deleteThread deletes exactly the rows it observed (D2)', () => {
  /**
   * THE SEAM GATE. `partition-flush.ts` detects the refusal and
   * `partition-delete.ts` owns the set of refused units, so both halves can
   * pass their own unit tests while the composition is inert. This is the only
   * test that spans them: a checkpoint re-put during the pass must keep its
   * META and PAYLOAD rows *and* the pending writes that belong to the same
   * checkpoint, which are refused only because the unit was carried forward
   * across the kind boundary. A later refactor of the flush's return shape
   * reopens the hole without it.
   */
  it('keeps a checkpoint re-put during the pass, and its pending writes with it', async () => {
    const thread = 'seam';
    const stored = threadConfig(thread, 'cp-1');
    await saver.put(threadConfig(thread), checkpoint('cp-1', 'A'), metadata);
    await saver.putWrites(stored, [['messages', { text: 'w'.repeat(600) }]], 'task-1');
    const racer = racingSaver(async () => {
      await saver.put(threadConfig(thread), checkpoint('cp-1', 'B'), metadata);
    });
    await racer.deleteThread(thread);
    racer.destroy();
    const tuple = await saver.getTuple(stored);
    expect(tuple?.checkpoint.id).toBe('cp-1');
    /**
     * The id alone would hold for the checkpoint written before the race as
     * well; the marker is what says the racer's write is the one that
     * survived, which is the whole claim of this test.
     */
    expect(String(tuple?.checkpoint.channel_values.blob)).toMatch(/^B/);
    expect(tuple?.pendingWrites?.map(([, channel]) => channel)).toEqual(['messages']);
    expect(await missingObjects()).toEqual([]);
    expect(warnings.some((line) => line.includes('rewritten since the read'))).toBe(true);
    expect(warnings.some((line) => line.includes('unit was refused'))).toBe(true);
  });

  /**
   * The residue the design keeps open and names: a pending write rewritten
   * during the pass outlives the checkpoint it belongs to. The hook fires
   * after the partition read and before any delete, so the racing write lands
   * while META and PAYLOAD are still there; they are deleted with the ids the
   * read observed, and only the WRITE row - whose id moved - is refused. It is a
   * leak, not a loss — no read path reaches it through the missing META row —
   * it is reported, and a second pass clears it.
   */
  it('leaves a pending write rewritten after its checkpoint is gone, and clears it on a re-run', async () => {
    const thread = 'orphan';
    const stored = threadConfig(thread, 'cp-1');
    await saver.put(threadConfig(thread), checkpoint('cp-1', 'C'), metadata);
    await saver.putWrites(stored, [['messages', { text: 'v'.repeat(600) }]], 'task-1');
    const partition = `CHKPT#${thread}`;
    const writeKey = (await sortKeysIn(partition)).find((key) => key.startsWith('WRITE#'));
    const racer = racingSaver(async () => {
      await reader.update({
        TableName: tableName,
        Key: { PK: partition, SK: writeKey },
        UpdateExpression: 'SET #group = :group',
        ExpressionAttributeNames: { '#group': 'writeGroup' },
        ExpressionAttributeValues: { ':group': 'rewritten-by-a-racer' },
      });
    });
    await racer.deleteThread(thread);
    racer.destroy();
    expect(await saver.getTuple(stored)).toBeUndefined();
    expect(await sortKeysIn(partition)).toEqual([writeKey]);
    expect(warnings.some((line) => line.includes('rewritten since the read'))).toBe(true);
    await saver.deleteThread(thread);
    expect(await sortKeysIn(partition)).toEqual([]);
  });

  /**
   * The deployment revision 4's pin would have left entirely unprotected: with
   * no `s3` configuration every payload is inline, and the id the delete pins
   * on rides on the descriptor either way.
   */
  it('refuses a rewritten row on an adapter with no S3 configuration', async () => {
    const plain = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG });
    const thread = 'inline';
    await plain.put(threadConfig(thread), checkpoint('cp-1', 'D'), metadata);
    const racer = racingSaver(async () => {
      await plain.put(threadConfig(thread), checkpoint('cp-1', 'E'), metadata);
    }, false);
    await racer.deleteThread(thread);
    racer.destroy();
    const tuple = await plain.getTuple(threadConfig(thread, 'cp-1'));
    expect(String(tuple?.checkpoint.channel_values.blob)).toMatch(/^E-x/);
    plain.destroy();
  });

  /**
   * A row written before the per-write id existed carries none, so it is
   * deleted unconditionally — asserted by rewriting it underneath the pass,
   * which a pinned row would have survived. Without this a table upgraded in
   * place could never be emptied.
   */
  it('deletes a row that carries no id at all, even rewritten under the pass', async () => {
    const thread = 'legacy';
    const partition = `CHKPT#${thread}`;
    const legacyRow = {
      PK: partition,
      SK: 'META##cp-old',
      v: 1,
      metadata: {
        location: 'INLINE',
        serdeType: 'json',
        compressed: false,
        bytes: new Uint8Array(1),
      },
    };
    await reader.put({ TableName: tableName, Item: legacyRow });
    const racer = racingSaver(async () => {
      await reader.put({
        TableName: tableName,
        Item: { ...legacyRow, metadata: { ...legacyRow.metadata, writeId: 'later' } },
      });
    }, false);
    await racer.deleteThread(thread);
    racer.destroy();
    expect(await sortKeysIn(partition)).toEqual([]);
  });
});

describe('clear deletes exactly the rows it observed (D3)', () => {
  /**
   * The session row is the one fixed-key row a history partition has, so an
   * append landing during the call rewrites the very row the read observed.
   * It survives, the messages the read saw are still deleted — a history
   * partition has no multi-row unit, so a refusal suppresses nothing — and the
   * count it is left holding is repaired by the public `reconcileMessageCount`.
   */
  it('keeps a session an append touched alive, and reconcileMessageCount repairs its count', async () => {
    const session = 'clear-race';
    await history.addMessages(session, [new HumanMessage('one'), new HumanMessage('two')]);
    const racing = racingHistory(async () => {
      await history.addMessages(session, [new HumanMessage('three')]);
    });
    await racing.clear(session);
    racing.destroy();
    expect((await history.getMessages(session)).map((message) => message.content)).toEqual([
      'three',
    ]);
    const listed = await history.listSessions();
    expect(listed.sessions.find((row) => row.sessionId === session)?.messageCount).toBe(3);
    await history.reconcileMessageCount(session);
    const repaired = await history.listSessions();
    expect(repaired.sessions.find((row) => row.sessionId === session)?.messageCount).toBe(1);
    expect(await missingObjects()).toEqual([]);
  });
});
