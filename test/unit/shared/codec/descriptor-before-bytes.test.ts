import { toPendingWrites } from '../../../../src/checkpointer/internal/item-reader';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import {
  type CodecDeps,
  decodePayload,
  type PayloadDescriptor,
  readPayloadBytes,
} from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { toPublicError } from '../../../../src/shared/errors/boundary';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { readStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import type { StoreItemRecord } from '../../../../src/store/types';

/** A serde that records whether anything ever asked it to deserialize. */
function countingSerde() {
  const calls: string[] = [];
  return {
    calls,
    serde: {
      dumpsTyped: JSON_SERDE.dumpsTyped.bind(JSON_SERDE),
      loadsTyped: async (type: string, data: Uint8Array | string) => {
        calls.push(type);
        return JSON_SERDE.loadsTyped(type, data);
      },
    },
  };
}

/** A WRITE row whose payload descriptor never survived — `null`, as a row can hold. */
const writeRow = (value: PayloadDescriptor): CheckpointWriteItem => ({
  PK: 'THREAD#t',
  SK: 'WRITE##ckpt-1#task-7#0',
  taskId: 'task-7',
  index: 0,
  channel: 'messages',
  writeGroup: 'g1',
  value,
});

/** The error `work` rejects with; a resolution is itself the failure. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  return work.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: Error) => error,
  );
}

/** The `{ code, field }` pair an awaited rejection carries. */
async function brandOf(work: Promise<unknown>): Promise<{ code?: string; field?: string }> {
  const coded = (await rejection(work)) as { code?: string; context?: { field?: string } };
  return { code: coded.code, field: coded.context?.field };
}

/**
 * `decodePayload` passed `descriptor.serdeType` and `await readPayloadBytes(…)`
 * as two arguments to one call. Arguments are evaluated left to right, so the
 * property read happened *before* the awaited call ran the guard that exists to
 * refuse exactly that descriptor — and a row whose payload is `null` raised a
 * bare `TypeError`, which the public boundary can only rebrand as
 * `UpstreamError`.
 */
describe('decodePayload reads the bytes before the serde type (L-01)', () => {
  const deps = (): CodecDeps => ({ serde: JSON_SERDE });

  it.each([
    ['null', null],
    ['absent', undefined],
    ['a string', 'not-a-descriptor'],
  ])('answers a %s descriptor with a ValidationError naming descriptor', async (_label, value) => {
    expect(await brandOf(decodePayload(value as never, deps(), []))).toEqual({
      code: ErrorCode.VALIDATION,
      field: 'descriptor',
    });
  });

  it('never asks the serde to deserialize a descriptor it refused', async () => {
    const { calls, serde } = countingSerde();

    await brandOf(decodePayload(null as never, { serde }, []));

    expect(calls).toEqual([]);
  });
});

/**
 * The history adapter reads the bytes itself and calls `loadsTyped` separately,
 * so it already answered this row with a branded error. The checkpointer and the
 * store go through `decodePayload`, and two adapters must not answer one row
 * shape differently — the classifier `getMessages` applies is shared.
 */
describe('every read path answers one malformed descriptor the same way (L-01)', () => {
  const nullDescriptor = null as never;

  function checkpointerContext(): CheckpointerContext {
    return { client: {} as never, tableName: 'ckpt', serde: JSON_SERDE, logger: SILENT_LOGGER };
  }

  function storeContext(): StoreContext {
    return {
      client: {} as never,
      tableName: 'store',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      maxSearchCandidates: 1000,
      maxScanItems: 10000,
      vectorScoreDirection: 'relevance',
    };
  }

  const storeRow = (): StoreItemRecord => ({
    PK: 'STORE#users',
    SK: 'u1#profile',
    namespace: ['users', 'u1'],
    key: 'profile',
    value: nullDescriptor,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('brands the pending-write, store and history reads identically', async () => {
    const history = await brandOf(readPayloadBytes(nullDescriptor, { serde: JSON_SERDE }, ['s']));
    const pendingWrites = await brandOf(
      toPendingWrites(checkpointerContext(), [writeRow(nullDescriptor)], 't'),
    );
    const store = await brandOf(readStoreItem(storeContext(), storeRow()));

    expect(history).toEqual({ code: ErrorCode.VALIDATION, field: 'descriptor' });
    expect(pendingWrites).toEqual(history);
    expect(store).toEqual(history);
  });

  /**
   * `descriptor` is one of the `ROW_REJECTION_FIELDS`, so this is permanent row
   * loss rather than a transport failure — which is what lets `getMessages`
   * honour `onCorruptMessage: 'skip'` instead of rethrowing it. A bare
   * `TypeError` carried no code and classified as neither.
   */
  it('classifies that error as permanent payload loss, as the skip policy needs', async () => {
    const caught = await rejection(decodePayload(nullDescriptor, { serde: JSON_SERDE }, []));

    expect(isPermanentPayloadLoss(caught)).toBe(true);
  });

  /**
   * What a caller actually sees. Every public method wraps its work in
   * `guardPublic`, which passes a branded library error through untouched and
   * can do nothing with an unbranded one but rebrand it — so before the reorder
   * a `null` payload reached `saver.getTuple`'s caller as `UPSTREAM`, the code
   * reserved for a failure of the service underneath.
   */
  it('reaches the caller as the error it was branded with, not as an upstream failure', async () => {
    const caught = await rejection(decodePayload(nullDescriptor, { serde: JSON_SERDE }, []));

    const surfaced = toPublicError(caught, 'getTuple') as { code?: string };
    const wasBare = toPublicError(new TypeError('cannot read serdeType'), 'getTuple') as {
      code?: string;
    };

    expect(surfaced).toBe(caught);
    expect(surfaced.code).toBe(ErrorCode.VALIDATION);
    expect(wasBare.code).toBe(ErrorCode.UPSTREAM);
  });
});
