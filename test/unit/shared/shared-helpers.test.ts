import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { readBodyBounded } from '../../../src/shared/codec/s3/bounded-body';
import { iterateRecencyIndex } from '../../../src/shared/dynamodb/index-query';
import { deletePartitionRows } from '../../../src/shared/dynamodb/partition-delete';
import { retryFor } from '../../../src/shared/dynamodb/retry-policy';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { walkObject } from '../../../src/shared/logging/redaction-walk';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

describe('retryFor', () => {
  const retry = { maxAttempts: 4 };

  /** No signal means no per-call allocation on the common path. */
  it('hands back the adapter s own options untouched when there is no signal', () => {
    expect(retryFor({ retry })).toBe(retry);
    expect(retryFor({})).toBeUndefined();
  });

  it('copies them and attaches the signal when there is one', () => {
    const signal = new AbortController().signal;
    expect(retryFor({ retry }, signal)).toEqual({ maxAttempts: 4, signal });
    expect(retryFor({ retry }, signal)).not.toBe(retry);
    expect(retryFor({}, signal)).toEqual({ signal });
  });
});

describe('readBodyBounded', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(1);

  function streamingBody(chunks: Uint8Array[]) {
    let destroyed = false;
    return {
      transformToByteArray: async () => bytes(0),
      destroy: () => {
        destroyed = true;
      },
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      get destroyed() {
        return destroyed;
      },
    };
  }

  it('buffers a streaming body that stays within the cap', async () => {
    const body = streamingBody([bytes(3), bytes(4)]);
    await expect(readBodyBounded(body as never, 'k', 10)).resolves.toHaveLength(7);
  });

  /** The rest is never fetched: the stream is destroyed the moment the cap is passed. */
  it('stops and destroys a streaming body once the cap is passed', async () => {
    const body = streamingBody([bytes(6), bytes(6)]);
    await expect(readBodyBounded(body as never, 'k', 10)).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(body.destroyed).toBe(true);
  });

  it('reads a non-streaming body whole and then checks it', async () => {
    const whole = { transformToByteArray: async () => bytes(4) };
    await expect(readBodyBounded(whole as never, 'k', 10)).resolves.toHaveLength(4);
    await expect(readBodyBounded(whole as never, 'k', 3)).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
  });

  /** A cap of zero admits only an empty body, which is a usable answer, not an error. */
  it('admits an empty body under a zero cap', async () => {
    const whole = { transformToByteArray: async () => bytes(0) };
    await expect(readBodyBounded(whole as never, 'k', 0)).resolves.toHaveLength(0);
  });
});

describe('iterateRecencyIndex', () => {
  const options = (client: ReturnType<typeof createStrictDocumentMock>['client']) => ({
    client,
    tableName: 't',
    indexName: 'gsi1',
    tag: 'CHKPT' as const,
    shards: 1,
    concurrency: 1,
  });

  /** A first page that fills up and reports a `LastEvaluatedKey` is followed by a second. */
  it('yields every row of the index, page after page', async () => {
    const { client, mock } = createStrictDocumentMock();
    let page = 0;
    mock.on(QueryCommand).callsFake(() => {
      page += 1;
      return page === 1
        ? {
            Items: Array.from({ length: 100 }, (_, i) => ({ gsi1sk: `2026#${100 - i}` })),
            LastEvaluatedKey: { gsi1sk: '2026#1' },
          }
        : { Items: [] };
    });
    const rows = [];
    for await (const row of iterateRecencyIndex(options(client))) rows.push(row);
    expect(rows).toHaveLength(100);
    expect(page).toBe(2);
  });

  /** An early break fetches no further page: that is the whole point of streaming it. */
  it('fetches no further page when the consumer stops', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: Array.from({ length: 100 }, (_, i) => ({ gsi1sk: `2026#${100 - i}` })),
      LastEvaluatedKey: { gsi1sk: '2026#1' },
    });
    for await (const _ of iterateRecencyIndex(options(client))) break;
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('yields nothing for an empty index', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const rows = [];
    for await (const row of iterateRecencyIndex(options(client))) rows.push(row);
    expect(rows).toEqual([]);
  });
});

describe('deletePartitionRows', () => {
  const base = (
    client: ReturnType<typeof createStrictDocumentMock>['client'],
    warn = jest.fn(),
  ) => ({
    client,
    tableName: 't',
    params: { TableName: 't' },
    logger: { ...SILENT_LOGGER, warn, info: jest.fn() },
    operation: 'test.delete',
    ownsSortKey: (sk: string) => sk.startsWith('MINE#'),
    descriptorsOf: () => [],
    scope: ['s1'],
  });

  it('deletes the rows it owns', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'p', SK: 'MINE#1' },
        { PK: 'p', SK: 'MINE#2' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({});
    await deletePartitionRows(base(client));
    const written = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.t;
    expect(written).toHaveLength(2);
  });

  /** A shared partition holding another adapter's row must never be wiped. */
  it('leaves a foreign row in place and reports it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'p', SK: 'MINE#1' },
        { PK: 'p', SK: 'THEIRS#1' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({});
    await deletePartitionRows(base(client, warn));
    const written = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.t;
    expect(written).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('foreign row'), {
      sortKey: 'THEIRS#1',
    });
  });

  it('issues no write for a partition that holds nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await deletePartitionRows(base(client));
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});

describe('walkObject', () => {
  const deps = {
    keyPatterns: ['password'],
    valuePatterns: [],
    walk: (value: unknown) => value as never,
  };

  it('recurses an array and a plain object through the walk it was given', () => {
    expect(walkObject([1, 2] as never, deps)).toEqual([1, 2]);
    expect(walkObject({ a: 1 } as never, deps)).toEqual({ a: 1 });
  });

  /** A payload is exactly what a log must not carry. */
  it('collapses a binary view to a label', () => {
    expect(walkObject(new Uint8Array(8) as never, deps)).toBe('[Uint8Array(8)]');
  });

  /** Collapsing these to `{}` would lose the only information they carry. */
  it('passes a Date and a RegExp through by reference', () => {
    const date = new Date(0);
    const pattern = /x/;
    expect(walkObject(date as never, deps)).toBe(date);
    expect(walkObject(pattern as never, deps)).toBe(pattern);
  });

  it('renders a Set and a Map as their contents', () => {
    expect(walkObject(new Set([1, 2]) as never, deps)).toEqual([1, 2]);
    expect(walkObject(new Map([['a', 1]]) as never, deps)).toEqual({ a: 1 });
  });

  it('redacts a secret-looking key of a plain object', () => {
    expect(walkObject({ password: 'hunter2' } as never, deps)).toEqual({
      password: '[REDACTED]',
    });
  });
});
