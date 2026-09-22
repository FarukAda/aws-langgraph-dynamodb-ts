import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

/**
 * The parts of a `RunnableConfig` every checkpointer route reads before it
 * reaches an identifier: the config itself, its `configurable` block and its
 * `signal`. Each is checked through the public method a caller uses, since a
 * check the method never reaches would still leave the value accepted.
 */

const throttle = (): Error =>
  Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

/** A saver whose every request is throttled, so one that goes out is retried and waits. */
function throttledSaver() {
  const { client, mock } = createStrictDocumentMock();
  mock.rejects(throttle());
  return {
    saver: new DynamoDBSaver({ tableName: 'ckpt', client, retry: { maxAttempts: 2 } }),
    mock,
  };
}

const CHECKPOINT = {
  v: 4,
  id: 'c2',
  ts: '2026-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const METADATA = { source: 'loop' as const, step: 0, parents: {} };
const IDS = { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'c1' };

type Route = (saver: DynamoDBSaver, config: RunnableConfig) => Promise<object | void>;

const ROUTES: [string, Route][] = [
  ['getTuple', (saver, config) => saver.getTuple(config)],
  ['list', (saver, config) => saver.list(config).next()],
  ['put', (saver, config) => saver.put(config, CHECKPOINT, METADATA)],
  ['putWrites', (saver, config) => saver.putWrites(config, [['ch', 1]], 'task-1')],
  [
    'getDeltaChannelHistory',
    (saver, config) => saver.getDeltaChannelHistory({ config, channels: ['ch'] }),
  ],
];

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

describe.each(ROUTES)('saver.%s config shape', (_name, call) => {
  /**
   * `{}` and `'x'` reached the retry loop's backoff wait, whose
   * `addEventListener` call threw a `TypeError` the boundary reported as an
   * `UpstreamError`; the one without `removeEventListener` threw from inside
   * the wait's timer instead, an uncaught exception, and the call never
   * settled.
   */
  it.each([
    ['an empty object', {}],
    ['a string', 'x'],
    ['null', null],
    ['a double without removeEventListener', { aborted: false, addEventListener: () => {} }],
  ])('refuses %s as config.signal, naming signal, before any request', async (_label, signal) => {
    const { saver, mock } = throttledSaver();
    await expect(call(saver, { configurable: IDS, signal: signal as never })).rejects.toEqual(
      refusal('signal'),
    );
    expect(mock.calls()).toHaveLength(0);
  });

  /**
   * A `configurable` that is not an object has no `thread_id` to read, so it
   * was taken for a config naming no thread: `list` scanned every thread in
   * the table and `getTuple` answered `undefined`.
   */
  it.each(['thread-1', null, [], 1])(
    'refuses configurable %p, naming configurable, before any request',
    async (configurable) => {
      const { saver, mock } = throttledSaver();
      await expect(call(saver, { configurable: configurable as never })).rejects.toEqual(
        refusal('configurable'),
      );
      expect(mock.calls()).toHaveLength(0);
    },
  );

  it('accepts a real AbortSignal beside a normal configurable', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    mock.on(PutCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client });
    const signal = new AbortController().signal;
    await call(saver, { configurable: IDS, signal });
    expect(mock.calls().length).toBeGreaterThan(0);
  });
});

describe('saver.list with a configurable that is not an object', () => {
  it('sends no table scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client });
    await expect(saver.list({ configurable: 'thread-1' } as never).next()).rejects.toEqual(
      refusal('configurable'),
    );
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('still lists every thread for a config with no configurable at all', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client });
    await expect(saver.list({}).next()).resolves.toEqual({ done: true, value: undefined });
    expect(mock.commandCalls(ScanCommand)).toHaveLength(1);
  });
});

/**
 * With no channels the walk reads nothing, so `getTuple`'s own check is never
 * reached; the method checks the config itself, as it already did for a
 * config that is not an object.
 */
describe('saver.getDeltaChannelHistory with no channels', () => {
  it('still refuses a malformed configurable or signal', async () => {
    const { saver } = throttledSaver();
    await expect(
      saver.getDeltaChannelHistory({ config: { configurable: 'x' } as never, channels: [] }),
    ).rejects.toEqual(refusal('configurable'));
    await expect(
      saver.getDeltaChannelHistory({ config: { signal: {} as never }, channels: [] }),
    ).rejects.toEqual(refusal('signal'));
  });
});
