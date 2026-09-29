import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { retryExhaustedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { persistRow, putWithRevisionSwap } from '../../../../src/store/internal/item-write';
import type { ExistingRowMeta, StoreItemRow } from '../../../../src/store/internal/rows';
import { landed } from '../../../shared/helpers/landed-swap';

const descriptor = (s3Key: string) => ({
  location: PayloadLocation.S3 as const,
  serdeType: 'json',
  compressed: false,
  s3Key,
});

const record = (): StoreItemRow => ({
  PK: 'STORE#n',
  SK: 'k',
  namespace: ['n'],
  key: 'k',
  value: descriptor('new'),
  createdAt: 'T0',
  updatedAt: 'T1',
  rev: 'mine',
});

/**
 * The guard rejection as a one-item transaction reports it. Every record here
 * is offloaded, so every write below goes out as a transaction and every
 * rejection arrives in this shape rather than as a bare exception name.
 */
const cancelledGuard = (item?: Record<string, unknown>) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', ...(item ? { Item: item } : {}) }],
  });

/** The request an offloaded put takes; its one item carries what a plain put took. */
interface TransactInput {
  TransactItems: { Put: Record<string, unknown> }[];
  ClientRequestToken: string;
}

function harness(options: {
  failures: number;
  reReads: ExistingRowMeta[];
  logger?: typeof SILENT_LOGGER;
}) {
  let puts = 0;
  const inputs: Record<string, unknown>[] = [];
  const send = (input: Record<string, unknown>): Record<string, never> => {
    inputs.push(input);
    puts += 1;
    if (puts <= options.failures) throw cancelledGuard();
    return {};
  };
  const context = {
    tableName: 'store',
    offloader: {},
    logger: options.logger ?? SILENT_LOGGER,
    client: {
      transactWrite: (input: TransactInput) => send(input.TransactItems[0].Put),
      get: () => {
        const next = options.reReads.shift();
        return {
          Item: next?.exists
            ? { createdAt: next.createdAt, value: next.value, rev: next.revision }
            : undefined,
        };
      },
    },
  };
  return { context, inputs, putCount: () => puts };
}

describe('putWithRevisionSwap', () => {
  it('commits on the first attempt and reports what it superseded', async () => {
    const { context, inputs } = harness({ failures: 0, reReads: [] });
    const previous: ExistingRowMeta = {
      exists: true,
      revision: 'r0',
      value: descriptor('old'),
      createdAt: 'T0',
    };

    const superseded = await landed(putWithRevisionSwap(context as never, record(), previous));

    expect(superseded.value).toEqual(descriptor('old'));
    expect(inputs[0].ConditionExpression).toBe('#rev = :rev');
    expect(inputs[0].ExpressionAttributeValues).toEqual({ ':rev': 'r0' });
  });

  it('re-reads and retries when another writer won the row', async () => {
    // The whole point: the racer must supersede what is *actually* there now,
    // not the stale descriptor it first read — otherwise both delete the same
    // object and one upload is orphaned.
    const { context, inputs, putCount } = harness({
      failures: 1,
      reReads: [{ exists: true, revision: 'r1', value: descriptor('theirs'), createdAt: 'T0' }],
    });

    const superseded = await landed(
      putWithRevisionSwap(context as never, record(), {
        exists: true,
        revision: 'r0',
        value: descriptor('old'),
        createdAt: 'T0',
      }),
    );

    expect(putCount()).toBe(2);
    expect(superseded.value).toEqual(descriptor('theirs'));
    expect(inputs[1].ExpressionAttributeValues).toEqual({ ':rev': 'r1' });
  });

  it('preserves createdAt discovered on a re-read', async () => {
    const { context } = harness({
      failures: 1,
      reReads: [{ exists: true, revision: 'r1', value: undefined, createdAt: 'ORIGINAL' }],
    });
    const item = record();

    await landed(putWithRevisionSwap(context as never, item, { exists: false }));

    expect(item.createdAt).toBe('ORIGINAL');
  });

  it('falls back to an unconditional write after the attempt bound, and warns', async () => {
    const warn = jest.fn();
    const { context, inputs, putCount } = harness({
      failures: 3,
      reReads: [
        { exists: true, revision: 'r1' },
        { exists: true, revision: 'r2' },
        { exists: true, revision: 'r3' },
      ],
      logger: { ...SILENT_LOGGER, warn },
    });

    await landed(putWithRevisionSwap(context as never, record(), { exists: true, revision: 'r0' }));

    expect(putCount()).toBe(4);
    expect(inputs[3].ConditionExpression).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('compare-and-swap'),
      expect.anything(),
    );
  });

  it('does not delete its own just-committed payload when a lost put response looks like a competitor win', async () => {
    // Attempt 1's PutCommand actually committed server-side, but the response
    // was lost (ECONNRESET etc.) and withDynamoDBRetry retried the guarded
    // put — which now sees its OWN just-written row and fails the condition,
    // indistinguishable from a competitor's win. The re-read finds the row
    // already holding this call's own rev ('mine', matching record().rev),
    // so the swap must report having superseded whatever the FIRST attempt
    // pinned ('old'), never this record's own value ('new').
    const { context, putCount } = harness({
      failures: 1,
      reReads: [{ exists: true, revision: 'mine', value: descriptor('new'), createdAt: 'T0' }],
    });

    const superseded = await landed(
      putWithRevisionSwap(context as never, record(), {
        exists: true,
        revision: 'r0',
        value: descriptor('old'),
        createdAt: 'T0',
      }),
    );

    expect(putCount()).toBe(1);
    expect(superseded.value).toEqual(descriptor('old'));
  });

  it('reports a non-conditional error untouched, pinned to the observation it was sent against', async () => {
    const boom = Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        transactWrite: () => {
          throw boom;
        },
        get: () => ({ Item: undefined }),
      },
    };

    await expect(
      putWithRevisionSwap(context as never, record(), { exists: false }),
    ).resolves.toEqual({ ok: false, reason: boom, pinned: { exists: false } });
  });

  /**
   * The rejected attempt may be this call's own landed write reported back, so
   * the failure carries that attempt's pin — here the competitor's row the first
   * rejection re-pinned on, not the observation the call started from.
   */
  it('reports a re-read that fails after a rejection, pinned to the attempt it turned away', async () => {
    const readDown = Object.assign(new Error('read down'), { name: 'ValidationException' });
    let writes = 0;
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        transactWrite: () => {
          writes += 1;
          throw writes === 1
            ? cancelledGuard({
                rev: { S: 'r1' },
                createdAt: { S: 'T-1' },
                value: {
                  M: {
                    location: { S: 'S3' },
                    serdeType: { S: 'json' },
                    compressed: { BOOL: false },
                    s3Key: { S: 'theirs' },
                  },
                },
              })
            : cancelledGuard();
        },
        get: () => {
          throw readDown;
        },
      },
    };

    await expect(
      putWithRevisionSwap(context as never, record(), { exists: true, revision: 'r0' }),
    ).resolves.toEqual({
      ok: false,
      reason: readDown,
      pinned: { exists: true, revision: 'r1', value: descriptor('theirs'), createdAt: 'T-1' },
    });
    expect(writes).toBe(2);
  });

  it('reports a failed fallback write, pinned to the last observation it overwrote', async () => {
    const bad = Object.assign(new Error('bad'), { name: 'ValidationException' });
    const reReads: ExistingRowMeta[] = [
      { exists: true, revision: 'r1', value: descriptor('one'), createdAt: 'T0' },
      { exists: true, revision: 'r2', value: descriptor('two'), createdAt: 'T0' },
      { exists: true, revision: 'r3', value: descriptor('three'), createdAt: 'T0' },
    ];
    let writes = 0;
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        transactWrite: () => {
          writes += 1;
          throw writes <= 3 ? cancelledGuard() : bad;
        },
        get: () => {
          const next = reReads.shift()!;
          return { Item: { createdAt: next.createdAt, value: next.value, rev: next.revision } };
        },
      },
    };

    await expect(
      putWithRevisionSwap(context as never, record(), { exists: true, revision: 'r0' }),
    ).resolves.toEqual({
      ok: false,
      reason: bad,
      pinned: { exists: true, revision: 'r3', value: descriptor('three'), createdAt: 'T0' },
    });
    expect(writes).toBe(4);
  });

  it('does not mistake a revision-less row for its own write when the record carries no nonce', async () => {
    // `rev` is optional on StoreItemRow, so `observed.revision === record.rev`
    // was a false-positive `undefined === undefined` against a pre-0.9.0 row:
    // the swap would report having won a race it never entered and delete the
    // descriptor it had pinned rather than retrying. put.ts always stamps a
    // nonce today, but the type permits a record that does not.
    const { context, putCount } = harness({
      failures: 1,
      reReads: [
        { exists: true, revision: undefined, value: descriptor('theirs'), createdAt: 'T0' },
      ],
    });
    const unnonced = { ...record(), rev: undefined };

    const superseded = await landed(
      putWithRevisionSwap(context as never, unnonced, {
        exists: true,
        revision: 'r0',
        value: descriptor('old'),
        createdAt: 'T0',
      }),
    );

    expect(putCount()).toBe(2);
    expect(superseded.value).toEqual(descriptor('theirs'));
  });
});

describe('putWithRevisionSwap with the rejected row on the exception', () => {
  /**
   * An inline record, because the row attached to the exception itself — rather
   * than to a cancellation reason — is the shape a plain put's rejection
   * carries, and the inline payload is what still goes out as a plain put. The
   * cancelled-transaction shape of the same rejection is covered beside this
   * file.
   */
  it('re-pins from the exception without a second read', async () => {
    let puts = 0;
    let reads = 0;
    const inputs: Record<string, unknown>[] = [];
    const rejected = Object.assign(new Error('rejected'), {
      name: 'ConditionalCheckFailedException',
      Item: {
        rev: { S: 'theirs-rev' },
        createdAt: { S: 'T-1' },
        value: {
          M: {
            location: { S: 'S3' },
            serdeType: { S: 'json' },
            compressed: { BOOL: false },
            s3Key: { S: 'theirs' },
          },
        },
      },
    });
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        put: (input: Record<string, unknown>) => {
          inputs.push(input);
          puts += 1;
          if (puts === 1) throw rejected;
          return {};
        },
        get: () => {
          reads += 1;
          return {};
        },
      },
    };
    const inlineRecord = {
      ...record(),
      value: {
        location: PayloadLocation.INLINE as const,
        serdeType: 'json',
        compressed: false,
        bytes: new Uint8Array([1]),
      },
    };
    const superseded = await landed(
      putWithRevisionSwap(context as never, inlineRecord, {
        exists: true,
        revision: 'stale',
      }),
    );
    expect(reads).toBe(0);
    expect(superseded).toEqual({
      exists: true,
      createdAt: 'T-1',
      value: descriptor('theirs'),
      revision: 'theirs-rev',
    });
    expect(inputs[1].ExpressionAttributeValues).toEqual({ ':rev': 'theirs-rev' });
  });
});

/**
 * A swap that re-pins on a competitor's row and then ends ambiguously — its
 * write landed, but the acknowledgement did not — superseded the competitor's
 * object, not the one this call first saw (the competitor already replaced and
 * released that). Releasing the first observation leaked the competitor's
 * object for good: no row names it once this write has landed.
 */
describe('persistRow after a re-pinned swap whose write landed without an answer', () => {
  const competitorRow = {
    rev: { S: 'r2' },
    createdAt: { S: 'T-1' },
    value: {
      M: {
        location: { S: 'S3' },
        serdeType: { S: 'json' },
        compressed: { BOOL: false },
        s3Key: { S: 'theirs' },
      },
    },
  };

  it('releases the object the landed write replaced: the one its re-pin observed', async () => {
    let writes = 0;
    const deleteBatch = jest.fn().mockResolvedValue([]);
    const context = {
      tableName: 'store',
      logger: SILENT_LOGGER,
      offloader: { deleteBatch, ownsKey: () => true },
      client: {
        transactWrite: () => {
          writes += 1;
          if (writes === 1) throw cancelledGuard(competitorRow);
          throw retryExhaustedError('Operation failed after 5 attempts', 5, new Error('timeout'));
        },
        get: () => ({ Item: { rev: 'mine' } }),
      },
    };

    await persistRow(context as never, record(), {
      exists: true,
      revision: 'r0',
      value: descriptor('old'),
      createdAt: 'T0',
    });

    expect(writes).toBe(2);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith(['theirs']);
  });
});

describe('createdAt after a delete/put race', () => {
  it("takes the put timestamp when the re-read finds the row gone, not the deleted row's createdAt", async () => {
    const { context, inputs } = harness({ failures: 1, reReads: [{ exists: false }] });
    await landed(
      putWithRevisionSwap(context as never, record(), { exists: true, revision: 'stale' }),
    );
    expect((inputs[1].Item as { createdAt: string }).createdAt).toBe('T1');
  });
});
