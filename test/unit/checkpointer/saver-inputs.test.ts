import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

function newSaver() {
  const { client, mock } = createStrictDocumentMock();
  return { saver: new DynamoDBSaver({ tableName: 'ckpt', client, serde }), mock };
}

/**
 * The checkpoint-id resolution mirrors the reference's `getCheckpointId`
 * (`checkpoint_id || thread_ts || ''`), but checks each candidate against
 * exactly the three values that fallthrough treats as absent, not full JS
 * truthiness.
 */
describe('checkpoint id resolution follows the reference, strictly', () => {
  it('falls through to thread_ts when checkpoint_id is "", matching the reference', async () => {
    const { saver, mock } = newSaver();
    mock.on(GetCommand).resolves({});
    await saver.getTuple({
      configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: '', thread_ts: 'abc' },
    });
    const key = mock.commandCalls(GetCommand)[0].args[0].input.Key as { SK: string };
    expect(key.SK).toBe('META##abc');
  });

  it('refuses thread_ts: 0, naming thread_ts rather than checkpoint_id', async () => {
    const { saver } = newSaver();
    await expect(
      saver.getTuple({
        configurable: { thread_id: 't', thread_ts: 0 as never },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'thread_ts' } });
  });
});

describe('list validates the positional config before options', () => {
  it('names config, not options.bogus, when both are malformed', async () => {
    const { saver } = newSaver();
    await expect(saver.list('x' as never, { bogus: 1 } as never).next()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'config' },
    });
  });
});

describe('getDeltaChannelHistory input validation', () => {
  it('refuses a null, undefined or non-object options bag, naming it', async () => {
    const { saver } = newSaver();
    for (const options of [null, undefined, 'x', 1]) {
      await expect(saver.getDeltaChannelHistory(options as never)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'options' },
      });
    }
  });

  it('refuses an options key this package does not read', async () => {
    const { saver } = newSaver();
    await expect(
      saver.getDeltaChannelHistory({
        config: { configurable: { thread_id: 't' } },
        channels: ['c'],
        foo: 1,
      } as never),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.foo' },
    });
  });

  /**
   * `channels: []` is deliberate here, not `['c']`: `deltaChannelHistory`
   * returns early for an empty channel list without ever calling `getTuple`,
   * so only an explicit, eager `config` check — not `getTuple`'s own,
   * downstream one — catches a malformed `config` paired with no channels to
   * walk.
   */
  it('refuses a non-object config even when channels is empty, naming it', async () => {
    const { saver } = newSaver();
    await expect(
      saver.getDeltaChannelHistory({ config: null, channels: [] } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'config' } });
  });

  /**
   * `channels` is required: LangGraph's only caller always passes it
   * (`@langchain/langgraph` `dist/channels/base.js:178`), and a config
   * without it used to reach `channels.length` on `undefined`, a bare
   * `TypeError` the boundary branded `UNEXPECTED_ERROR`.
   */
  it('refuses a missing channels, naming it', async () => {
    const { saver } = newSaver();
    await expect(
      saver.getDeltaChannelHistory({
        config: { configurable: { thread_id: 't' } },
      } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'channels' } });
  });

  it('refuses channels that is not an array of strings, naming it', async () => {
    const { saver } = newSaver();
    const config = { configurable: { thread_id: 't' } };
    for (const channels of ['x', [1], [null]]) {
      await expect(
        saver.getDeltaChannelHistory({ config, channels } as never),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'channels' } });
    }
  });

  it('accepts channels: [], which reads nothing rather than being refused', async () => {
    const { saver } = newSaver();
    await expect(
      saver.getDeltaChannelHistory({
        config: { configurable: { thread_id: 't' } },
        channels: [],
      }),
    ).resolves.toEqual({});
  });

  it('accepts a well-formed options bag and walks from the named checkpoint', async () => {
    const { saver, mock } = newSaver();
    mock.on(QueryCommand).resolves({ Items: [] });
    await expect(
      saver.getDeltaChannelHistory({
        config: { configurable: { thread_id: 't', checkpoint_ns: '' } },
        channels: ['a'],
      }),
    ).resolves.toEqual({ a: { writes: [] } });
  });
});

/**
 * `put` used to read `checkpoint.id` with no shape check of its own: a `null`
 * or `undefined` checkpoint reached that property access directly and raised
 * a bare `TypeError`, which the error boundary branded `UNEXPECTED_ERROR`
 * instead of naming the caller's mistake.
 */
describe('put checkpoint validation', () => {
  const metadata = { source: 'loop' as const, step: 0, parents: {} };

  it('refuses a null or undefined checkpoint, naming it', async () => {
    const { saver } = newSaver();
    for (const checkpoint of [null, undefined]) {
      await expect(
        saver.put({ configurable: { thread_id: 't' } }, checkpoint as never, metadata),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'checkpoint' } });
    }
  });

  it('accepts a well-formed checkpoint and stores it', async () => {
    const { saver, mock } = newSaver();
    mock.on(TransactWriteCommand).resolves({});
    const checkpoint = {
      v: 4,
      id: 'ckpt-1',
      ts: '',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    const result = await saver.put({ configurable: { thread_id: 't' } }, checkpoint, metadata);
    expect(result.configurable?.checkpoint_id).toBe('ckpt-1');
  });
});

/**
 * `putWrites` validated `taskId` but never `writes` itself: a `writes` that
 * was not an array, or an entry that was not itself an array, reached
 * `writes.length` or a destructuring `for...of` directly and raised a bare
 * `TypeError`, branded `UNEXPECTED_ERROR` instead of naming the caller's
 * mistake.
 */
describe('putWrites writes validation', () => {
  const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };

  it('refuses a writes that is not an array, naming it', async () => {
    const { saver } = newSaver();
    for (const writes of ['x', null, undefined, {}]) {
      await expect(saver.putWrites(config, writes as never, 'task-1')).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'writes' },
      });
    }
  });

  it('refuses a writes entry that is not itself an array, naming writes', async () => {
    const { saver } = newSaver();
    await expect(saver.putWrites(config, [null] as never, 'task-1')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'writes' },
    });
  });

  it('writes nothing when a valid entry precedes a malformed one', async () => {
    const { saver, mock } = newSaver();
    mock.on(PutCommand).resolves({});
    await expect(
      saver.putWrites(config, [['ch', 'a'], null] as never, 'task-1'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'writes' } });
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('accepts writes: [], a no-op that writes nothing', async () => {
    const { saver, mock } = newSaver();
    await expect(saver.putWrites(config, [], 'task-1')).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('accepts a valid [channel, value] tuple list and writes it', async () => {
    const { saver, mock } = newSaver();
    mock.on(PutCommand).resolves({});
    await saver.putWrites(config, [['ch', 'v']], 'task-1');
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
