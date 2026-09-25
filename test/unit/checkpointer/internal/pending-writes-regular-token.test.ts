import { writeRegularItems } from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/internal/rows';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

/** The request a plain put takes, and the item shape a transaction wraps. */
interface WriteInput {
  TableName: string;
  Item: DocItem;
  ConditionExpression?: string;
  ReturnValuesOnConditionCheckFailure?: string;
}

/** The request an offloaded write takes. */
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

const item = (writeGroup: string, value: CheckpointWriteItem['value']): CheckpointWriteItem => ({
  PK: 'CHKPT#t',
  SK: `WRITE##c1#task#0000000008#ch-${writeGroup}`,
  taskId: 'task',
  index: 0,
  channel: 'ch',
  writeGroup,
  occurrence: 0,
  value,
});

/** The first-write-wins rejection as a one-item transaction reports it. */
const cancelledGuard = (row?: DocItem) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', ...(row ? { Item: row } : {}) }],
  });

/** A client double recording both write shapes, refusing each one with `fail`. */
function recorder(fail?: () => Error) {
  const emitted: Emitted[] = [];
  const send = (entry: Emitted): Record<string, never> => {
    emitted.push(entry);
    if (fail) throw fail();
    return {};
  };
  const context = {
    tableName: 'ckpt',
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
      get: () => ({}),
    },
  };
  return { context, emitted };
}

describe('an offloaded regular write goes out under a request token', () => {
  it('sends one transaction item carrying the guard fragments the plain put carried', async () => {
    const { context, emitted } = recorder();
    const row = item('G1', offloaded('k/G1'));

    await expect(writeRegularItems(context as never, [row])).resolves.toEqual({ deadUploads: [] });

    expect(emitted.map((entry) => entry.kind)).toEqual(['transact']);
    expect(emitted[0].items).toBe(1);
    expect(emitted[0].put).toEqual({
      TableName: 'ckpt',
      Item: row,
      ConditionExpression: 'attribute_not_exists(PK)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(emitted[0].token).toHaveLength(36);
  });

  it('keeps the fan-out at one transaction per item, each with its own token', async () => {
    const { context, emitted } = recorder();
    const rows = [
      item('G1', offloaded('a')),
      item('G2', offloaded('b')),
      item('G3', offloaded('c')),
    ];

    await writeRegularItems(context as never, rows);

    expect(emitted).toHaveLength(3);
    expect(emitted.map((entry) => entry.items)).toEqual([1, 1, 1]);
    expect(emitted.map((entry) => entry.put.Item)).toEqual(rows);
    expect(new Set(emitted.map((entry) => entry.token)).size).toBe(3);
  });
});

describe('an inline regular write is left exactly as it was', () => {
  it('emits the same plain request, key for key, although an offloader is configured', async () => {
    const { context, emitted } = recorder();
    const row = item('G1', inline());

    await writeRegularItems(context as never, [row]);

    expect(emitted.map((entry) => entry.kind)).toEqual(['put']);
    expect(emitted[0].token).toBeUndefined();
    expect(Object.keys(emitted[0].request)).toEqual([
      'TableName',
      'Item',
      'ConditionExpression',
      'ReturnValuesOnConditionCheckFailure',
    ]);
    expect(emitted[0].request).toEqual({
      TableName: 'ckpt',
      Item: row,
      ConditionExpression: 'attribute_not_exists(PK)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });

  it('routes each item of a mixed fan-out on its own descriptor, not on the adapter', async () => {
    const { context, emitted } = recorder();

    await writeRegularItems(context as never, [
      item('G1', inline()),
      item('G2', offloaded('b')),
      item('G3', inline()),
    ]);

    expect(emitted.map((entry) => entry.kind)).toEqual(['put', 'transact', 'put']);
  });
});

describe('a first-write-wins rejection arriving as a cancelled transaction', () => {
  it('marks the upload dead when the cancellation carries a row of another call', async () => {
    const row = item('G1', offloaded('k/G1'));
    const { context } = recorder(() =>
      cancelledGuard({ channel: { S: 'ch' }, writeGroup: { S: 'OTHER' } }),
    );

    await expect(writeRegularItems(context as never, [row])).resolves.toEqual({
      deadUploads: [row],
    });
  });

  it('keeps the upload when the cancellation carries the row this call wrote itself', async () => {
    const row = item('G1', offloaded('k/G1'));
    const { context } = recorder(() =>
      cancelledGuard({ channel: { S: 'ch' }, writeGroup: { S: 'G1' } }),
    );

    await expect(writeRegularItems(context as never, [row])).resolves.toEqual({ deadUploads: [] });
  });
});

/**
 * A table double honouring a request token the way the service does: a
 * transaction re-sent under a token it already applied is discarded instead of
 * applied a second time. A plain put carries no token and so has nothing to
 * discard, which is the whole of the difference the routing decides.
 *
 * The interleaving is the one this closes. The write lands, its acknowledgement
 * is lost, a concurrent call releases the object this row names, and the retry
 * of the identical request arrives at a partition where
 * `attribute_not_exists(PK)` holds again.
 */
function racedByADelete() {
  const applied = new Set<string>();
  let row: DocItem | undefined;
  let requests = 0;
  const send = (written: DocItem, token?: string): Record<string, never> => {
    requests += 1;
    if (token !== undefined && applied.has(token)) return {};
    row = written;
    if (token !== undefined) applied.add(token);
    if (requests > 1) return {};
    row = undefined;
    throw Object.assign(new Error('connection reset'), { name: 'ECONNRESET' });
  };
  const context = {
    tableName: 'ckpt',
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

    await writeRegularItems(table.context as never, [item('G1', offloaded('k/G1'))]);

    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(false);
  });

  it('still resurrects an inline row, which is the outcome that has not changed', async () => {
    const table = racedByADelete();

    await writeRegularItems(table.context as never, [item('G1', inline())]);

    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(true);
  });
});
