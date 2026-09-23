import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { mockClient } from 'aws-sdk-client-mock';

import { assembleTuple } from '../../../src/checkpointer/internal/read';
import type { CheckpointMetaItem } from '../../../src/checkpointer/internal/rows';
import { setUpCheckpointer } from '../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { isMissingObjectError } from '../../../src/shared/codec/payload-loss';
import type { DocItem } from '../../../src/shared/dynamodb/client';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import {
  committedRows,
  createStrictDocumentMock,
  resolveRowWrites,
} from '../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

const s3Mock = mockClient(S3Client);

/** Objects the seeding writes uploaded, served back to the reads under test. */
const stored = new Map<string, Uint8Array>();

afterEach(() => {
  s3Mock.reset();
  stored.clear();
});

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 2, parents: {} };

const THREAD = { configurable: { thread_id: 't', checkpoint_ns: '' } };
const CHECKPOINT = {
  configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'ckpt-1' },
};

/**
 * A saver whose every payload offloads (`thresholdBytes: 1`), so each row it
 * writes names an S3 object and each row it reads has a download that can be
 * made to fail. The key prefix is fixed so the keys read back off the rows are
 * the ones the reads are asserted to name.
 */
function saverOptions(client: DynamoDBDocument) {
  return {
    tableName: 'ckpt',
    client,
    serde,
    logger: SILENT_LOGGER,
    s3: {
      bucketName: 'b',
      keyPrefix: 'ckpt/',
      thresholdBytes: 1,
      createS3Client: () => new S3Client({ region: 'us-east-1' }),
    },
  };
}

/** S3's answer for an object that is not there: a 404 the classifier refuses to retry. */
function noSuchKey(): Error {
  return Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

/** A transient S3 failure: the 503 the shared classifier retries until the budget is spent. */
function slowDown(): Error {
  return Object.assign(new Error('Please reduce your request rate.'), {
    name: 'SlowDown',
    $metadata: { httpStatusCode: 503 },
  });
}

/** One key made unreadable, and the error S3 answers it with. */
interface Failure {
  key: string;
  error: () => Error;
}

/** Keep every upload, and answer every download from what was kept — except `failure`'s key. */
function stubS3(failure?: Failure): void {
  s3Mock.on(PutObjectCommand).callsFake((input: { Key: string; Body: Uint8Array }) => {
    stored.set(input.Key, new Uint8Array(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input: { Key: string }) => {
    if (failure !== undefined && input.Key === failure.key) throw failure.error();
    const bytes = stored.get(input.Key);
    if (bytes === undefined) throw noSuchKey();
    return { ContentLength: bytes.length, Body: { transformToByteArray: () => bytes } };
  });
}

/** The rows one checkpoint and one pending write commit. */
interface Rows {
  meta: CheckpointMetaItem;
  payload: DocItem;
  writes: DocItem[];
}

/**
 * Write a checkpoint and one pending write through the public saver, keeping
 * the rows they committed. The rows are the writer's own, not hand-built, so a
 * descriptor the writer stops producing cannot leave these reads passing.
 */
async function seed(): Promise<Rows> {
  const { client, mock } = createStrictDocumentMock();
  resolveRowWrites(mock);
  stubS3();
  const saver = new DynamoDBSaver(saverOptions(client));
  await saver.put(THREAD, checkpoint, metadata);
  await saver.putWrites(CHECKPOINT, [['messages', 'x']], 'task-1');
  const rows = committedRows(mock);
  const at = (prefix: string): DocItem[] => rows.filter((row) => String(row.SK).startsWith(prefix));
  return {
    meta: at('META#')[0] as CheckpointMetaItem,
    payload: at('PAYLOAD#')[0],
    writes: at('WRITE#'),
  };
}

/**
 * The S3 key a stored descriptor points at. A descriptor that stayed inline has
 * none, and failing a key of `undefined` would leave a test asserting nothing,
 * so that is reported here rather than further down.
 */
function keyOf(descriptor: unknown): string {
  const key = (descriptor as { s3Key?: string }).s3Key;
  if (typeof key !== 'string') throw new Error('this payload did not offload; it names no object');
  return key;
}

/** Serve `rows` back to every read a tuple assembly makes. */
function serveRows(mock: ReturnType<typeof createStrictDocumentMock>['mock'], rows: Rows): void {
  mock.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: DocItem }) => {
    const prefix = String(input.ExpressionAttributeValues[':skPrefix']);
    return prefix.startsWith('META') ? { Items: [rows.meta] } : { Items: rows.writes };
  });
  mock
    .on(GetCommand)
    .callsFake((input: { Key: DocItem }) =>
      String(input.Key.SK).startsWith('META') ? { Item: rows.meta } : { Item: rows.payload },
    );
}

/** A saver reading `rows` with one object unreadable, and the table mock behind it. */
function readerFor(rows: Rows, failure: Failure) {
  const { client, mock } = createStrictDocumentMock();
  serveRows(mock, rows);
  s3Mock.reset();
  stubS3(failure);
  return { saver: new DynamoDBSaver(saverOptions(client)), mock, client };
}

/** An error carrying this library's branded fields, so each can be asserted on its own. */
type Coded = Error & {
  code?: string;
  context?: Record<string, unknown>;
  cause?: Coded;
};

/** The error `run` rejected with; a run that resolves is itself the failure. */
async function rejection(run: () => Promise<unknown>): Promise<Coded> {
  try {
    await run();
  } catch (error) {
    return error as Coded;
  }
  throw new Error('expected the read to reject, but it resolved');
}

/** How many times S3 was asked for `key`. */
function downloadsOf(key: string): number {
  return s3Mock
    .commandCalls(GetObjectCommand)
    .filter((call) => (call.args[0].input as { Key?: string }).Key === key).length;
}

describe('a checkpoint read whose offloaded object cannot be downloaded', () => {
  it('reports a spent retry budget as S3_OFFLOAD_FAILED naming the download and the key', async () => {
    const rows = await seed();
    const key = keyOf((rows.payload as { checkpoint?: unknown }).checkpoint);
    const { saver } = readerFor(rows, { key, error: slowDown });
    const error = await rejection(() => saver.getTuple(THREAD));
    expect(error).toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      context: { operation: 'download', key },
    });
    /** The spent budget survives as the cause, so a caller can still see it was retried. */
    expect(error.cause).toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
      context: { attempts: 3 },
    });
    expect(downloadsOf(key)).toBe(3);
  });

  /**
   * The store answers a gone object by re-reading the row, because an overwrite
   * deletes the object it superseded. A checkpoint's objects are never deleted
   * by a competing write — each put uploads under an id of its own — so the
   * checkpointer reports instead: one read of the row, one attempt at the
   * object, and a failure rather than the `undefined` that means "no such
   * checkpoint".
   */
  it('reports a gone object rather than re-reading the row or answering "no checkpoint"', async () => {
    const rows = await seed();
    const key = keyOf((rows.payload as { checkpoint?: unknown }).checkpoint);
    const { saver, mock } = readerFor(rows, { key, error: noSuchKey });
    const error = await rejection(() => saver.getTuple(THREAD));
    expect(error).toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      context: { operation: 'download', key },
    });
    expect(isMissingObjectError(error)).toBe(true);
    expect(downloadsOf(key)).toBe(1);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  /**
   * A pending write's payload is downloaded beside the checkpoint's, not after
   * it. A tuple that came back with the write missing would replay the graph
   * from a state the run never reached, so the read fails and names the write's
   * own object.
   */
  it('fails the whole tuple, naming the write, when the object behind a pending write is gone', async () => {
    const rows = await seed();
    const key = keyOf((rows.writes[0] as { value?: unknown }).value);
    const { saver } = readerFor(rows, { key, error: noSuchKey });
    const error = await rejection(() => saver.getTuple(THREAD));
    expect(error).toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      context: { operation: 'download', key },
    });
  });

  it('names the metadata object when that is the one that cannot be fetched', async () => {
    const rows = await seed();
    const key = keyOf((rows.meta as { metadata?: unknown }).metadata);
    const { saver } = readerFor(rows, { key, error: noSuchKey });
    const error = await rejection(() => saver.getTuple(THREAD));
    expect(error).toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      context: { operation: 'download', key },
    });
  });
});

describe('the three checkpointer read paths agree on a failed download', () => {
  /** The branded fields a caller branches on, from whichever path produced the error. */
  function verdict(error: Coded): Record<string, unknown> {
    return { code: error.code, ...error.context };
  }

  it('surfaces the same error from list as from getTuple, from the first next()', async () => {
    const rows = await seed();
    const key = keyOf((rows.payload as { checkpoint?: unknown }).checkpoint);
    const fromGetTuple = await rejection(() =>
      readerFor(rows, { key, error: noSuchKey }).saver.getTuple(THREAD),
    );
    const listing = readerFor(rows, { key, error: noSuchKey }).saver.list(THREAD);
    const fromList = await rejection(() => listing.next());
    expect(verdict(fromList)).toEqual(verdict(fromGetTuple));
    expect(verdict(fromList)).toEqual({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      operation: 'download',
      key,
    });
  });

  /**
   * A filtered listing decodes the metadata itself, before the tuple is
   * assembled, so its download happens on a different line of a different
   * module from the unfiltered one. The caller is told the same thing.
   */
  it('answers a filtered listing, which downloads the metadata earlier, the same way', async () => {
    const rows = await seed();
    const key = keyOf((rows.meta as { metadata?: unknown }).metadata);
    const plain = readerFor(rows, { key, error: noSuchKey }).saver.list(THREAD);
    const fromPlain = await rejection(() => plain.next());
    const filtered = readerFor(rows, { key, error: noSuchKey }).saver.list(THREAD, {
      filter: { source: 'loop' },
    });
    const fromFiltered = await rejection(() => filtered.next());
    expect(verdict(fromFiltered)).toEqual(verdict(fromPlain));
    expect(verdict(fromFiltered)).toEqual({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      operation: 'download',
      key,
    });
  });

  /**
   * `assembleTuple` is the seam both public paths reach the download through,
   * and it is driven here only to show it adds nothing of its own: the error a
   * caller sees is the one the codec raised, unwrapped and unrebranded.
   */
  it('adds nothing of its own in assembleTuple, the seam both public paths share', async () => {
    const rows = await seed();
    const key = keyOf((rows.payload as { checkpoint?: unknown }).checkpoint);
    const { saver, client } = readerFor(rows, { key, error: noSuchKey });
    const fromGetTuple = await rejection(() => saver.getTuple(THREAD));
    const { context } = setUpCheckpointer(saverOptions(client), serde);
    const fromAssemble = await rejection(() =>
      assembleTuple(context, { threadId: 't', checkpointNs: '' }, rows.meta, { consistent: true }),
    );
    expect(verdict(fromAssemble)).toEqual(verdict(fromGetTuple));
  });
});
