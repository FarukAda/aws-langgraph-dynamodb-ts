import { PayloadLocation } from '../../../../src/shared/codec/codec';
import type { DocItem } from '../../../../src/shared/dynamodb/types';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putWithRevisionSwap } from '../../../../src/store/internal/overwrite-swap';
import type { ExistingRecordMeta } from '../../../../src/store/internal/read-existing';
import type { StoreItemRecord } from '../../../../src/store/types';

/** The request a plain put takes, and the item shape a transaction wraps. */
interface WriteInput {
  TableName: string;
  Item: DocItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string>;
  ReturnValuesOnConditionCheckFailure?: string;
}

/** The request an offloaded put takes. */
interface TransactInput {
  TransactItems: { Put: WriteInput }[];
  ClientRequestToken: string;
}

/** One emitted write, whichever of the two shapes it took. */
interface Emitted {
  kind: 'put' | 'transact';
  token?: string;
  items: number;
  request: WriteInput | TransactInput;
  put: WriteInput;
}

const offloaded = (s3Key: string) => ({
  location: PayloadLocation.S3 as const,
  serdeType: 'json',
  compressed: false,
  s3Key,
});

const inline = () => ({
  location: PayloadLocation.INLINE as const,
  serdeType: 'json',
  compressed: false,
  bytes: new Uint8Array([1, 2, 3]),
});

const record = (value: StoreItemRecord['value']): StoreItemRecord => ({
  PK: 'STORE#n',
  SK: 'k',
  namespace: ['n'],
  key: 'k',
  value,
  createdAt: 'T0',
  updatedAt: 'T1',
  rev: 'mine',
});

/** The guard rejection as a one-item transaction reports it. */
const cancelledGuard = (item?: DocItem) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', ...(item ? { Item: item } : {}) }],
  });

/** The same rejection as a plain conditional put reports it. */
const conditionalFailure = () =>
  Object.assign(new Error('rejected'), { name: 'ConditionalCheckFailedException' });

/**
 * A client double recording both write shapes, turning the first `failures` of
 * them away with whichever rejection that shape really carries.
 */
function recorder(options: { failures: number; reReads?: ExistingRecordMeta[] }) {
  const emitted: Emitted[] = [];
  const reReads = options.reReads ?? [];
  const send = (entry: Emitted): Record<string, never> => {
    emitted.push(entry);
    if (emitted.length > options.failures) return {};
    throw entry.kind === 'put' ? conditionalFailure() : cancelledGuard();
  };
  const context = {
    tableName: 'store',
    offloader: {},
    logger: SILENT_LOGGER,
    client: {
      put: (input: WriteInput) => send({ kind: 'put', items: 1, request: input, put: input }),
      transactWrite: (input: TransactInput) =>
        send({
          kind: 'transact',
          token: input.ClientRequestToken,
          items: input.TransactItems.length,
          request: input,
          put: input.TransactItems[0].Put,
        }),
      get: () => {
        const next = reReads.shift();
        return {
          Item: next?.exists
            ? { createdAt: next.createdAt, value: next.value, rev: next.revision }
            : undefined,
        };
      },
    },
  };
  return { context, emitted };
}

const pinnedToR0: ExistingRecordMeta = { exists: true, revision: 'r0', value: offloaded('old') };

describe('an offloaded put goes out under a request token', () => {
  it('sends one transaction item carrying the guard fragments the plain put carried', async () => {
    const { context, emitted } = recorder({ failures: 0 });

    await putWithRevisionSwap(context as never, record(offloaded('new')), pinnedToR0);

    expect(emitted.map((entry) => entry.kind)).toEqual(['transact']);
    expect(emitted[0].items).toBe(1);
    expect(emitted[0].put).toEqual({
      TableName: 'store',
      Item: record(offloaded('new')),
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 'r0' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(emitted[0].token).toHaveLength(36);
  });

  it('draws a fresh token for the re-pin, never the one the cancelled attempt spent', async () => {
    const { context, emitted } = recorder({
      failures: 1,
      reReads: [{ exists: true, revision: 'r1', value: offloaded('theirs') }],
    });

    await putWithRevisionSwap(context as never, record(offloaded('new')), pinnedToR0);

    expect(emitted.map((entry) => entry.kind)).toEqual(['transact', 'transact']);
    expect(emitted[0].put.ExpressionAttributeValues).toEqual({ ':rev': 'r0' });
    expect(emitted[1].put.ExpressionAttributeValues).toEqual({ ':rev': 'r1' });
    expect(emitted[0].token).not.toBe(emitted[1].token);
    expect(emitted[1].token).toHaveLength(36);
  });

  it('carries a token on the unconditional write the exhausted swap falls back to', async () => {
    const { context, emitted } = recorder({
      failures: 3,
      reReads: [
        { exists: true, revision: 'r1' },
        { exists: true, revision: 'r2' },
        { exists: true, revision: 'r3' },
      ],
    });

    await putWithRevisionSwap(context as never, record(offloaded('new')), pinnedToR0);

    expect(emitted).toHaveLength(4);
    expect(emitted[3].kind).toBe('transact');
    expect(emitted[3].put.ConditionExpression).toBeUndefined();
    expect(emitted[3].token).toHaveLength(36);
    expect(new Set(emitted.map((entry) => entry.token)).size).toBe(4);
  });
});

describe('an inline put is left exactly as it was', () => {
  it('emits the same plain request, key for key, with nothing added', async () => {
    const { context, emitted } = recorder({ failures: 0 });
    const item = record(inline());

    await putWithRevisionSwap(context as never, item, pinnedToR0);

    expect(emitted.map((entry) => entry.kind)).toEqual(['put']);
    expect(emitted[0].token).toBeUndefined();
    expect(Object.keys(emitted[0].request)).toEqual([
      'TableName',
      'Item',
      'ReturnValuesOnConditionCheckFailure',
      'ConditionExpression',
      'ExpressionAttributeNames',
      'ExpressionAttributeValues',
    ]);
    expect(emitted[0].request).toEqual({
      TableName: 'store',
      Item: item,
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 'r0' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });
});

/**
 * A table double honouring a request token the way the service does: a
 * transaction re-sent under a token it already applied is discarded instead of
 * applied a second time. A plain put carries no token and so has nothing to
 * discard, which is the whole of the difference the routing decides.
 *
 * The interleaving is the one this closes. The creation lands, its
 * acknowledgement is lost, a concurrent delete removes the row and releases
 * its object, and the retry of the identical request arrives at a partition
 * where `attribute_not_exists(PK)` holds again.
 */
function racedByADelete() {
  const applied = new Set<string>();
  let row: DocItem | undefined;
  let requests = 0;
  const send = (item: DocItem, token?: string): Record<string, never> => {
    requests += 1;
    if (token !== undefined && applied.has(token)) return {};
    row = item;
    if (token !== undefined) applied.add(token);
    if (requests > 1) return {};
    row = undefined;
    throw Object.assign(new Error('connection reset'), { name: 'ECONNRESET' });
  };
  const context = {
    tableName: 'store',
    offloader: {},
    logger: SILENT_LOGGER,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, rng: () => 0 },
    client: {
      put: (input: WriteInput) => send(input.Item),
      transactWrite: (input: TransactInput) =>
        send(input.TransactItems[0].Put.Item, input.ClientRequestToken),
      get: () => ({ Item: undefined }),
    },
  };
  return { context, survives: () => row !== undefined, requests: () => requests };
}

describe('a lost acknowledgement whose retry re-lands', () => {
  it('leaves the row a concurrent delete removed deleted, when the payload was offloaded', async () => {
    const table = racedByADelete();

    await putWithRevisionSwap(table.context as never, record(offloaded('new')), { exists: false });

    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(false);
  });

  it('still resurrects an inline row, which is the outcome that has not changed', async () => {
    const table = racedByADelete();

    await putWithRevisionSwap(table.context as never, record(inline()), { exists: false });

    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(true);
  });
});

describe('a guard rejection arriving as a cancelled transaction', () => {
  it('re-pins from the row the cancellation reason carries, with no second read', async () => {
    const emitted: Emitted[] = [];
    let reads = 0;
    const rejection = cancelledGuard({
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
    });
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        transactWrite: (input: TransactInput) => {
          emitted.push({
            kind: 'transact',
            token: input.ClientRequestToken,
            items: input.TransactItems.length,
            request: input,
            put: input.TransactItems[0].Put,
          });
          if (emitted.length === 1) throw rejection;
          return {};
        },
        get: () => {
          reads += 1;
          return {};
        },
      },
    };

    const superseded = await putWithRevisionSwap(context as never, record(offloaded('new')), {
      exists: true,
      revision: 'stale',
    });

    expect(reads).toBe(0);
    expect(superseded).toEqual({
      exists: true,
      createdAt: 'T-1',
      value: offloaded('theirs'),
      revision: 'theirs-rev',
    });
    expect(emitted[1].put.ExpressionAttributeValues).toEqual({ ':rev': 'theirs-rev' });
  });
});
