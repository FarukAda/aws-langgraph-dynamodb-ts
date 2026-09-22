import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import type { BatchWriteAllIncompleteError } from '../../../src/shared/errors/errors';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../shared/helpers/ddb-mock';

/**
 * `SerializerProtocol` is typed `Promise<...>`; this fake's own computation is
 * synchronous and neither method throws, so a non-async function returning
 * `Promise.resolve(...)` already has type `Promise<...>` and needs neither
 * `async` nor `await`.
 */
const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

async function drain(gen: AsyncGenerator<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe('DynamoDBSaver', () => {
  it('names the field rather than crashing when the constructor options are null', () => {
    expect(() => new DynamoDBSaver(null as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'options' } }),
    );
  });

  it('put delegates to a transactional write and returns the new config', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const result = await saver.put({ configurable: { thread_id: 't' } }, checkpoint, metadata);
    expect(result.configurable?.checkpoint_id).toBe('ckpt-1');
  });

  it('getTuple returns undefined when nothing is stored', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(await saver.getTuple({ configurable: { thread_id: 't' } })).toBeUndefined();
  });

  it('list yields nothing for an empty thread', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(await drain(saver.list({ configurable: { thread_id: 't' } }))).toEqual([]);
  });

  /**
   * H-10: `list` is a generator, so nothing runs until the first pull —
   * asserting on the call itself would pass vacuously.
   */
  it('refuses a non-string checkpoint_id in `before`', async () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const iterator = saver.list(
      { configurable: { thread_id: 't' } },
      { before: { configurable: { checkpoint_id: 123 } } as never },
    );
    await expect(iterator.next()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'before' },
    });
  });

  it('refuses a `list` options key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const iterator = saver.list({ configurable: { thread_id: 't' } }, {
      limit: 1,
      bogus: true,
    } as never);
    await expect(iterator.next()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.bogus' },
    });
  });

  describe('list: `before`, `config` and `filter` shape', () => {
    it('refuses a non-object `before`, `config` or `filter`', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      const cfg = { configurable: { thread_id: 't' } };
      await expect(saver.list(cfg, { before: 'x' as never }).next()).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'before' },
      });
      await expect(saver.list('x' as never).next()).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'config' },
      });
      await expect(saver.list(cfg, { filter: 'x' as never }).next()).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'filter' },
      });
    });

    /**
     * `config` is required, not optional — a JS caller can still pass `null`
     * or omit it. Both used to fail downstream with a raw `TypeError`, wrapped
     * as `UpstreamError`; the shared config reader now refuses them the same
     * way as any other non-object config, naming `config` instead.
     */
    it('refuses a null or undefined config, naming it', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      await expect(saver.list(null as never).next()).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'config' },
      });
      await expect(saver.list(undefined as never).next()).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'config' },
      });
    });

    it('refuses a malformed truthy checkpoint_id in `before`, naming it', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      await expect(
        saver
          .list(
            { configurable: { thread_id: 't' } },
            { before: { configurable: { checkpoint_id: 'a#b' } } },
          )
          .next(),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'before' } });
    });

    it('accepts `before: {}`, an absent checkpoint_id (undefined/null/""), and a non-operator filter clause', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(QueryCommand).resolves({ Items: [] });
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      const cfg = { configurable: { thread_id: 't' } };
      await expect(drain(saver.list(cfg, { before: {} }))).resolves.toEqual([]);
      await expect(
        drain(saver.list(cfg, { before: { configurable: { checkpoint_id: '' } } })),
      ).resolves.toEqual([]);
      await expect(
        drain(saver.list(cfg, { before: { configurable: { checkpoint_id: null } as never } })),
      ).resolves.toEqual([]);
      await expect(drain(saver.list(cfg, { filter: { a: { $foo: 1 } } }))).resolves.toEqual([]);
    });

    /**
     * `0`, `false` and `NaN` are falsy in JS but none can be a checkpoint id;
     * the boundary is exactly `undefined`/`null`/`''`, not JS truthiness, so
     * each must reach `validateIdentifier` and be refused as a non-string
     * rather than silently read as "no bound".
     */
    it('refuses 0, false and NaN as a checkpoint_id rather than treating them as absent', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      const cfg = { configurable: { thread_id: 't' } };
      for (const checkpointId of [0, false, Number.NaN]) {
        await expect(
          saver
            .list(cfg, { before: { configurable: { checkpoint_id: checkpointId } } as never })
            .next(),
        ).rejects.toMatchObject({
          code: ErrorCode.VALIDATION,
          context: { field: 'before' },
        });
      }
    });
  });

  describe('a non-object config on every method that reads one', () => {
    /**
     * `config.configurable` used to be read straight off the argument, so a
     * `null` or `undefined` config reached a bare `TypeError` from that
     * property access — caught by the error boundary and reported as an
     * `UpstreamError`, an AWS-side failure, instead of naming the caller's
     * mistake. The shared config reader now refuses any non-object config
     * before any property is read off it.
     */
    it('getTuple refuses a null, undefined or non-object config, naming it', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      for (const cfg of [null, undefined, 'x', 1]) {
        await expect(saver.getTuple(cfg as never)).rejects.toMatchObject({
          code: ErrorCode.VALIDATION,
          context: { field: 'config' },
        });
      }
    });

    it('put refuses a null, undefined or non-object config, naming it', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      for (const cfg of [null, undefined, 'x', 1]) {
        await expect(saver.put(cfg as never, checkpoint, metadata)).rejects.toMatchObject({
          code: ErrorCode.VALIDATION,
          context: { field: 'config' },
        });
      }
    });

    it('putWrites refuses a null, undefined or non-object config, naming it', async () => {
      const { client } = createStrictDocumentMock();
      const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
      for (const cfg of [null, undefined, 'x', 1]) {
        await expect(saver.putWrites(cfg as never, [['ch', 1]], 'task-1')).rejects.toMatchObject({
          code: ErrorCode.VALIDATION,
          context: { field: 'config' },
        });
      }
    });
  });

  /**
   * `0`, `false` and `NaN` are falsy in JS but none can be a checkpoint id;
   * "no id" is exactly `undefined`, `null` or `''`, so each of these must
   * reach `validateCheckpointId` and be refused as a non-string rather than
   * silently read as "the latest".
   */
  it('getTuple refuses 0, false and NaN as a checkpoint_id, and still accepts "" and null', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    for (const checkpointId of [0, false, Number.NaN]) {
      await expect(
        saver.getTuple({ configurable: { thread_id: 't', checkpoint_id: checkpointId as never } }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'checkpoint_id' } });
    }
    for (const checkpointId of ['', null]) {
      await expect(
        saver.getTuple({ configurable: { thread_id: 't', checkpoint_id: checkpointId as never } }),
      ).resolves.toBeUndefined();
    }
  });

  it('putWrites delegates to a conditional put for a regular write', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await saver.putWrites(
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'v']],
      'task-1',
    );
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it('deleteThread is a no-op when the thread is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await saver.deleteThread('t');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('refuses a deleteThread options key this package does not read', async () => {
    const { client, mock } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await expect(saver.deleteThread('t', { bogus: true } as never)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.bogus' },
    });
    expect(mock.calls()).toHaveLength(0);
  });

  it('does not destroy an injected client', () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(() => saver.destroy()).not.toThrow();
  });

  it('destroys the client it owns', () => {
    const destroy = jest.fn();
    const fakeClient = {
      destroy,
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fakeClient as never,
      serde,
    });
    saver.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation via RunnableConfig.signal (CORE-04)', () => {
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };
  const expectAborted = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });

  it('rejects getTuple, list, put, putWrites and deleteThread before any DynamoDB call', async () => {
    const { client, mock } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const config = { configurable: { thread_id: 't', checkpoint_id: 'ckpt-1' }, signal: aborted() };
    await expectAborted(saver.getTuple(config));
    await expectAborted(drain(saver.list(config)));
    await expectAborted(saver.put(config, checkpoint, metadata));
    await expectAborted(saver.putWrites(config, [['ch', 1]], 'task-1'));
    await expectAborted(saver.deleteThread('t', { signal: aborted() }));
    expect(mock.calls()).toHaveLength(0);
  });

  it('stops a multi-page deleteThread when the signal aborts between pages', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    let pages = 0;
    mock.on(QueryCommand).callsFake(() => {
      pages += 1;
      controller.abort();
      // Only the first page announces a continuation, so the read stays finite even
      // when cancellation is ignored; honouring the signal must stop it after one fetch.
      return pages === 1
        ? {
            Items: [{ PK: 'CHKPT#t', SK: 'META##c1' }],
            LastEvaluatedKey: { PK: 'CHKPT#t', SK: 'x' },
          }
        : { Items: [] };
    });
    mock.on(DeleteCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await expect(saver.deleteThread('t', { signal: controller.signal })).rejects.toMatchObject({
      code: ErrorCode.ABORTED,
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  /**
   * The promise is "BatchWriteAllIncompleteError when a row's delete fails,
   * counting rows rather than batches and carrying what did succeed". A row
   * whose *handling* threw — here the decode of the row a rejection carries,
   * which an injected client can hand back already unmarshalled — reached no
   * tally, so the flush ended early, the pass saw no failure, and the caller
   * was told a thread was deleted that was mostly still in the table.
   */
  it('reports an incomplete deleteThread when a row s handling throws, with counts that add up', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: Array.from({ length: 20 }, (_, i) => ({ PK: 'CHKPT#t', SK: `WRITE##c1#task#${i}` })),
    });
    let deleted = 0;
    mock.on(DeleteCommand).callsFake(async (input: { Key?: { SK?: string } }) => {
      if (input.Key?.SK === 'WRITE##c1#task#7') {
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
          Item: { PK: 'CHKPT#t', SK: input.Key.SK },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      deleted += 1;
      return {};
    });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const raised = await saver.deleteThread('t').then(
      () => undefined,
      (error: BatchWriteAllIncompleteError) => error,
    );
    expect(raised).toMatchObject({ code: ErrorCode.BATCH_WRITE_INCOMPLETE });
    expect(raised?.succeededCount).toBe(deleted);
    expect((raised?.succeededChunks ?? 0) + (raised?.failedChunks.length ?? 0)).toBe(
      raised?.totalChunks,
    );
  });
});
