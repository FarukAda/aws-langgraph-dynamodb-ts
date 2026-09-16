import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { backfillRecencyIndex } from '../../../../src/shared/dynamodb/backfill-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const meta = { PK: 'CHKPT#t1', SK: 'META##c1', checkpointId: 'c1' };
const payload = { PK: 'CHKPT#t1', SK: 'PAYLOAD##c1' };
const item = { PK: 'STORE#users', SK: 'u1#k', updatedAt: '2026-01-01T00:00:00.000Z' };
const session = {
  PK: 'HIST#s1',
  SK: 'HISTORY#SESSION',
  sessionId: 's1',
  updatedAt: '2026-02-02T00:00:00.000Z',
};
const message = { PK: 'HIST#s1', SK: 'MSG#01ABC' };

const TABLE = 'tbl';
const ok = () => createStrictDocumentMock().client;

describe('backfillRecencyIndex', () => {
  it('writes index keys for the rows a listing reaches, and skips the rest', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [meta, payload, item, session, message] });
    mock.on(UpdateCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: TABLE });
    expect(result).toMatchObject({ scanned: 5, indexed: 3, skipped: 2 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(3);
  });

  /**
   * A row a live adapter already indexed carries its true timestamp; replacing
   * it with the pre-index epoch would move a live row to the bottom of every
   * listing. The write is conditional so re-running is safe.
   */
  it('never overwrites keys a row already has', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [session] });
    mock.on(UpdateCommand).resolves({});
    await backfillRecencyIndex({ client, tableName: TABLE });
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ConditionExpression).toBe('attribute_not_exists(#gpk)');
  });

  it('skips rows that already carry keys at the scan, not in memory', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await backfillRecencyIndex({ client, tableName: TABLE });
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toBe(
      'attribute_not_exists(#gpk)',
    );
  });

  it('reports what it would do without writing, under dryRun: true, and writes under dryRun: false', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [meta, item] });
    mock.on(UpdateCommand).resolves({});
    const dry = await backfillRecencyIndex({ client, tableName: TABLE, dryRun: true });
    expect(dry.indexed).toBe(2);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
    const wet = await backfillRecencyIndex({ client, tableName: TABLE, dryRun: false });
    expect(wet.indexed).toBe(2);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it('returns a cursor at the page cap and resumes from it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolves({ Items: [session], LastEvaluatedKey: { PK: 'HIST#s1', SK: 'HISTORY#SESSION' } });
    mock.on(UpdateCommand).resolves({});
    const first = await backfillRecencyIndex({ client, tableName: TABLE, maxPages: 1 });
    expect(first.nextCursor).toBeDefined();
    await backfillRecencyIndex({
      client,
      tableName: TABLE,
      maxPages: 1,
      cursor: first.nextCursor,
    });
    const resumed = mock.commandCalls(ScanCommand).at(-1)?.args[0].input;
    expect(resumed?.ExclusiveStartKey).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
  });

  it('reads every page when no page cap is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [meta], LastEvaluatedKey: { PK: 'CHKPT#t1', SK: 'META##c1' } })
      .resolves({ Items: [session] });
    mock.on(UpdateCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: TABLE });
    expect(result).toEqual({ scanned: 2, indexed: 2, skipped: 0 });
  });

  /** DynamoDB omits `Items` entirely for a page whose every row the filter dropped. */
  it('treats a page that returns no Items as an empty page', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({});
    const result = await backfillRecencyIndex({ client, tableName: TABLE });
    expect(result).toEqual({ scanned: 0, indexed: 0, skipped: 0 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('accepts every option at its default and a cursor this tool issued', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(
      backfillRecencyIndex({
        client,
        tableName: TABLE,
        indexShards: 8,
        pageSize: 50,
        maxPages: 5,
        cursor: undefined,
        dryRun: false,
        retry: { maxAttempts: 2 },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ scanned: 0, indexed: 0, skipped: 0 });
  });

  it('refuses a cursor it did not issue', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      backfillRecencyIndex({ client, tableName: TABLE, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'cursor' } });
  });

  /** The base64url encoding of each malformed cursor shape, built through the public method. */
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it.each([
    ['an array', b64([])],
    ['an object missing SK', b64({ PK: 'a' })],
    ['an object with a non-string SK', b64({ PK: 'a', SK: 1 })],
    ['an object carrying a key beyond PK and SK', b64({ PK: 'a', SK: 'b', extra: 1 })],
  ])('refuses a cursor decoding to %s, naming it', async (_name, cursor) => {
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, cursor }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'cursor' } });
  });

  it('a valid retry: { maxAttempts: 2 } produces exactly 2 attempts on a retryable error', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .rejectsOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }))
      .resolves({ Items: [] });
    await backfillRecencyIndex({ client, tableName: TABLE, retry: { maxAttempts: 2 } });
    expect(mock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  /**
   * `onRetry` is backfill's only way to observe retries in progress, since it
   * takes no `logger` — the reason `retry` had to stay typed `RetryOptions`
   * rather than narrow to the adapters' `RetryPolicy`.
   */
  it('invokes retry.onRetry on a retryable error', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .rejectsOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }))
      .resolves({ Items: [] });
    const onRetry = jest.fn();
    await backfillRecencyIndex({ client, tableName: TABLE, retry: { maxAttempts: 2, onRetry } });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('backfillRecencyIndex error boundary', () => {
  /**
   * The tool is its own error boundary, like every adapter method: an error
   * that is not this package's own reaches the caller as `UpstreamError`, with
   * the original kept as `cause` so nothing about it is lost.
   */
  it('wraps a raw error the client throws as UpstreamError, with the original as cause', async () => {
    const original = new Error('socket hang up');
    const client = { scan: jest.fn().mockRejectedValue(original), update: jest.fn() };
    const error = await backfillRecencyIndex({ client: client as never, tableName: TABLE }).then(
      () => undefined,
      (rejection: Error) => rejection,
    );
    expect(error).toMatchObject({ name: 'UpstreamError', code: ErrorCode.UPSTREAM });
    expect((error as Error).cause).toBe(original);
    expect(client.scan).toHaveBeenCalledTimes(1);
  });
});

describe('backfillRecencyIndex input validation', () => {
  it('refuses an options key this package does not read', async () => {
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, foo: 1 } as never),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.foo' },
    });
  });

  it('refuses a tableName DynamoDB would reject, naming it', async () => {
    for (const tableName of ['', 'ab', 'bad#name', 123 as never]) {
      await expect(backfillRecencyIndex({ client: ok(), tableName })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'tableName' },
      });
    }
  });

  it('refuses a client missing scan or update, naming which', async () => {
    await expect(
      backfillRecencyIndex({ client: null as never, tableName: TABLE }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'client' } });
    await expect(
      backfillRecencyIndex({ client: {} as never, tableName: TABLE }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'client.scan' } });
  });

  it('accepts a client exposing exactly scan and update, nothing else', async () => {
    const client = { scan: jest.fn().mockResolvedValue({ Items: [] }), update: jest.fn() };
    await expect(
      backfillRecencyIndex({ client: client as never, tableName: TABLE }),
    ).resolves.toMatchObject({ scanned: 0, indexed: 0, skipped: 0 });
  });

  it.each([
    ['indexShards', 0],
    ['indexShards', -1],
    ['indexShards', 1.5],
    ['indexShards', Number.NaN],
    ['indexShards', 'x'],
    ['indexShards', null],
    ['indexShards', 1025],
    ['pageSize', 0],
    ['pageSize', -1],
    ['pageSize', 1.5],
    ['pageSize', Number.NaN],
    ['pageSize', 'x'],
    ['pageSize', null],
    ['maxPages', 0],
    ['maxPages', -1],
    ['maxPages', 1.5],
    ['maxPages', Number.NaN],
    ['maxPages', 'x'],
    ['maxPages', null],
  ])('refuses %s=%p, naming it', async (field, value) => {
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, [field]: value } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field } });
  });

  it('accepts indexShards at its cap and pageSize/maxPages with no cap of their own', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(
      backfillRecencyIndex({ client, tableName: TABLE, indexShards: 1024 }),
    ).resolves.toMatchObject({ scanned: 0 });
    await expect(
      backfillRecencyIndex({ client, tableName: TABLE, pageSize: 1_000_000_000_000 }),
    ).resolves.toMatchObject({ scanned: 0 });
    await expect(
      backfillRecencyIndex({ client, tableName: TABLE, maxPages: 1_000_000_000_000 }),
    ).resolves.toMatchObject({ scanned: 0 });
  });

  /**
   * `dryRun: "false"` is truthy in JS, so the old `if (options.dryRun) return
   * true` read a config built from a string (an environment variable, a CLI
   * flag) as `dryRun: true`: a run configured to write silently wrote nothing
   * and reported success.
   */
  it('refuses a non-boolean dryRun, naming it', async () => {
    for (const dryRun of ['false', 1, null]) {
      await expect(
        backfillRecencyIndex({ client: ok(), tableName: TABLE, dryRun: dryRun as never }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'dryRun' } });
    }
  });

  /**
   * A malformed retry policy used to reach the retry loop itself and exhaust
   * its (nonsensical) attempt budget, reporting `RetryExhaustedError` — an
   * AWS-side failure — for what is a caller's config mistake.
   */
  it('refuses a malformed retry policy, naming it, rather than exhausting retries', async () => {
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, retry: 'x' as never }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'retry' } });
    await expect(
      backfillRecencyIndex({
        client: ok(),
        tableName: TABLE,
        retry: { maxAttempts: 'x' as never },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'retry.maxAttempts' },
    });
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, retry: { maxAttempts: 0 } }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'retry.maxAttempts' },
    });
  });

  /**
   * `retry` accepts the full `RetryOptions` surface, not just the adapters'
   * three numeric bounds — `onRetry` is backfill's only way to observe
   * retries, since it takes no `logger`, so the hooks must stay accepted.
   */
  it.each([
    ['retryableErrors', 'x', 'retry.retryableErrors'],
    ['retryableErrors', [1], 'retry.retryableErrors'],
    ['isRetryable', 'x', 'retry.isRetryable'],
    ['onRetry', 'x', 'retry.onRetry'],
    ['rng', 'x', 'retry.rng'],
    ['signal', 'x', 'retry.signal'],
  ])('refuses retry.%s=%p, naming %s', async (key, value, field) => {
    await expect(
      backfillRecencyIndex({ client: ok(), tableName: TABLE, retry: { [key]: value } as never }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field },
    });
  });

  it('accepts a retry policy using the full RetryOptions surface', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(
      backfillRecencyIndex({
        client,
        tableName: TABLE,
        retry: {
          maxAttempts: 3,
          retryableErrors: ['ThrottlingException'],
          isRetryable: () => false,
          onRetry: () => undefined,
          rng: () => 0.5,
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toMatchObject({ scanned: 0 });
  });

  it('refuses a signal that is not AbortSignal-like, naming it', async () => {
    for (const signal of ['x', {}, null]) {
      await expect(
        backfillRecencyIndex({ client: ok(), tableName: TABLE, signal: signal as never }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'signal' } });
    }
  });

  /**
   * The function had no error boundary at all before this validation existed:
   * `null`, `undefined` or a non-object `options` reached a bare `TypeError`
   * instead of this package's branded error. Every one of them is now caught
   * by shape validation before any property read, so each now names a field
   * rather than merely being branded.
   */
  it('refuses a null, undefined or non-object options bag, naming it', async () => {
    for (const options of [null, undefined, 'x', 1]) {
      await expect(backfillRecencyIndex(options as never)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'options' },
      });
    }
  });
});
