import type { CheckpointWriteItem } from '../../../../src/checkpointer/internal/rows';
import { writeSpecialItem } from '../../../../src/checkpointer/internal/special-write-cas';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../../../src/shared/dynamodb/conditional-put';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

/** The request a plain put takes, and the item shape a transaction wraps. */
interface WriteInput {
  TableName: string;
  Item: DocItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string>;
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
  bytes: new Uint8Array([7, 8, 9]),
});

const item = (value: CheckpointWriteItem['value']): CheckpointWriteItem => ({
  PK: 'CHKPT#t',
  SK: 'WRITE##c1#task#0000000007#__error__',
  taskId: 'task',
  index: -1,
  channel: '__error__',
  writeGroup: 'g2',
  occurrence: 0,
  value,
});

/** The row a read observes, holding `group` as its guard attribute. */
const heldBy = (group: string, s3Key: string): DocItem => ({
  value: offloaded(s3Key),
  writeGroup: group,
});

/** The compare-and-swap rejection as a one-item transaction reports it. */
const cancelledGuard = (row?: DocItem) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', ...(row ? { Item: row } : {}) }],
  });

/** The same rejection as a plain conditional put reports it. */
const conditionalFailure = () =>
  Object.assign(new Error('rejected'), { name: 'ConditionalCheckFailedException' });

/**
 * A client double recording both write shapes and answering the reads in order,
 * turning the first `failures` writes away with whichever rejection that shape
 * really carries.
 */
function recorder(options: { failures: number; reads?: DocItem[]; offloader?: boolean }) {
  const emitted: Emitted[] = [];
  const reads = [...(options.reads ?? [])];
  let gets = 0;
  const send = (entry: Emitted): Record<string, never> => {
    emitted.push(entry);
    if (emitted.length > options.failures) return {};
    throw entry.kind === 'put' ? conditionalFailure() : cancelledGuard();
  };
  const context = {
    tableName: 'ckpt',
    logger: SILENT_LOGGER,
    ...(options.offloader === false ? {} : { offloader: {} }),
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
        gets += 1;
        return { Item: reads.shift() };
      },
    },
  };
  return { context, emitted, gets: () => gets };
}

describe('an offloaded special write goes out under a request token', () => {
  it('sends the compare-and-swap as one transaction item, pinned exactly as before', async () => {
    const { context, emitted } = recorder({ failures: 0, reads: [heldBy('g1', 'old')] });
    const row = item(offloaded('new'));

    const outcome = await writeSpecialItem(context as never, row);

    expect(outcome).toEqual({ committed: true, superseded: offloaded('old') });
    expect(emitted.map((entry) => entry.kind)).toEqual(['transact']);
    expect(emitted[0].items).toBe(1);
    expect(emitted[0].put).toEqual({
      TableName: 'ckpt',
      Item: row,
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'writeGroup' },
      ExpressionAttributeValues: { ':rev': 'g1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(emitted[0].token).toHaveLength(36);
  });

  it('draws a fresh token for the re-pin, never the one the cancelled attempt spent', async () => {
    const { context, emitted } = recorder({
      failures: 1,
      reads: [heldBy('g1', 'old'), heldBy('g9', 'theirs')],
    });

    const outcome = await writeSpecialItem(context as never, item(offloaded('new')));

    expect(outcome).toEqual({ committed: true, superseded: offloaded('theirs') });
    expect(emitted.map((entry) => entry.kind)).toEqual(['transact', 'transact']);
    expect(emitted[0].put.ExpressionAttributeValues).toEqual({ ':rev': 'g1' });
    expect(emitted[1].put.ExpressionAttributeValues).toEqual({ ':rev': 'g9' });
    expect(emitted[0].token).not.toBe(emitted[1].token);
    expect(emitted[1].token).toHaveLength(36);
  });

  it('carries a token on the unconditional overwrite the exhausted swap falls back to', async () => {
    const { context, emitted } = recorder({
      failures: OVERWRITE_CAS_MAX_ATTEMPTS,
      reads: [heldBy('g1', 'old'), heldBy('c1', 't1'), heldBy('c2', 't2'), heldBy('c3', 't3')],
    });

    const outcome = await writeSpecialItem(context as never, item(offloaded('new')));

    expect(outcome).toEqual({ committed: true, superseded: offloaded('t3') });
    expect(emitted).toHaveLength(OVERWRITE_CAS_MAX_ATTEMPTS + 1);
    expect(emitted[3].kind).toBe('transact');
    expect(Object.keys(emitted[3].put)).toEqual(['TableName', 'Item']);
    expect(emitted[3].token).toHaveLength(36);
    expect(new Set(emitted.map((entry) => entry.token)).size).toBe(4);
  });
});

describe('an inline special write is left exactly as it was', () => {
  it('emits the compare-and-swap as the same plain request, key for key', async () => {
    const { context, emitted } = recorder({ failures: 0, reads: [heldBy('g1', 'old')] });
    const row = item(inline());

    await writeSpecialItem(context as never, row);

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
      TableName: 'ckpt',
      Item: row,
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'writeGroup' },
      ExpressionAttributeValues: { ':rev': 'g1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });

  it('leaves the exhausted fallback the bare two-key put it has always been', async () => {
    const { context, emitted } = recorder({
      failures: OVERWRITE_CAS_MAX_ATTEMPTS,
      reads: [heldBy('g1', 'old'), heldBy('c1', 't1'), heldBy('c2', 't2'), heldBy('c3', 't3')],
    });
    const row = item(inline());

    await writeSpecialItem(context as never, row);

    expect(emitted).toHaveLength(OVERWRITE_CAS_MAX_ATTEMPTS + 1);
    expect(emitted[3].kind).toBe('put');
    /** Key order too, so "unchanged, key for key" is proven for every inline emission. */
    expect(Object.keys(emitted[3].request)).toEqual(['TableName', 'Item']);
    expect(emitted[3].request).toEqual({ TableName: 'ckpt', Item: row });
  });

  /**
   * The rejected row attached to the exception itself, rather than to a
   * cancellation reason, is the shape a plain put answers with — so it is the
   * inline payload that still meets it. The same rejection in its cancelled
   * form is pinned below.
   */
  it('re-pins from the row the bare exception carries, with no second read', async () => {
    const emitted: Emitted[] = [];
    let gets = 0;
    const rejected = Object.assign(new Error('rejected'), {
      name: 'ConditionalCheckFailedException',
      Item: {
        writeGroup: { S: 'g9' },
        value: {
          M: {
            location: { S: 'S3' },
            serdeType: { S: 'json' },
            compressed: { BOOL: false },
            s3Key: { S: 'racer' },
          },
        },
      },
    });
    const context = {
      tableName: 'ckpt',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        put: (input: WriteInput) => {
          emitted.push({ kind: 'put', items: 1, request: input, put: input });
          if (emitted.length === 1) throw rejected;
          return {};
        },
        get: () => {
          gets += 1;
          return { Item: heldBy('g1', 'old') };
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item(inline()));

    expect(outcome).toEqual({ committed: true, superseded: offloaded('racer') });
    expect(gets).toBe(1);
    expect(emitted[1].put.ExpressionAttributeValues).toEqual({ ':rev': 'g9' });
  });
});

describe('the write without an offloader stays out of the change', () => {
  it('keeps its plain put even for a descriptor that names an object', async () => {
    const { context, emitted, gets } = recorder({ failures: 0, offloader: false });
    const row = item(offloaded('new'));

    const outcome = await writeSpecialItem(context as never, row);

    expect(outcome).toEqual({ committed: true });
    expect(emitted.map((entry) => entry.kind)).toEqual(['put']);
    expect(emitted[0].token).toBeUndefined();
    expect(Object.keys(emitted[0].request)).toEqual(['TableName', 'Item']);
    expect(emitted[0].request).toEqual({ TableName: 'ckpt', Item: row });
    expect(gets()).toBe(0);
  });
});

describe('a compare-and-swap rejection arriving as a cancelled transaction', () => {
  it('re-pins from the row the cancellation reason carries, with no second read', async () => {
    const emitted: Emitted[] = [];
    let gets = 0;
    const rejection = cancelledGuard({
      writeGroup: { S: 'g9' },
      value: {
        M: {
          location: { S: 'S3' },
          serdeType: { S: 'json' },
          compressed: { BOOL: false },
          s3Key: { S: 'racer' },
        },
      },
    });
    const context = {
      tableName: 'ckpt',
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
          gets += 1;
          return { Item: heldBy('g1', 'old') };
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item(offloaded('new')));

    expect(outcome).toEqual({ committed: true, superseded: offloaded('racer') });
    expect(gets).toBe(1);
    expect(emitted[1].put.ExpressionAttributeValues).toEqual({ ':rev': 'g9' });
    expect(emitted[0].token).not.toBe(emitted[1].token);
  });
});

/**
 * A table double honouring a request token the way the service does: a
 * transaction re-sent under a token it already applied is discarded instead of
 * applied a second time. A plain put carries no token and so has nothing to
 * discard, which is the whole of the difference the routing decides.
 *
 * The interleaving is the one the unconditional overwrite most needs closed.
 * It has no condition to turn a re-send away, so with the acknowledgement lost
 * and the row removed since, nothing but the token stops the retry landing a
 * row that names an object nobody will write again.
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

    const outcome = await writeSpecialItem(table.context as never, item(offloaded('new')));

    expect(outcome.committed).toBe(true);
    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(false);
  });

  it('still resurrects an inline row, which is the outcome that has not changed', async () => {
    const table = racedByADelete();

    await writeSpecialItem(table.context as never, item(inline()));

    expect(table.requests()).toBe(2);
    expect(table.survives()).toBe(true);
  });
});
