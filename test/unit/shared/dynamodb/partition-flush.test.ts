import {
  DeleteCommand,
  type DeleteCommandInput,
  type DynamoDBDocument,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import { DELETE_CONCURRENCY } from '../../../../src/shared/constants';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { writeIdGuard } from '../../../../src/shared/dynamodb/idempotent-write';
import {
  type FlushDeps,
  flushPendingDeletes,
  type PendingDelete,
} from '../../../../src/shared/dynamodb/partition-flush';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function deps(client: DynamoDBDocument, extra: Partial<FlushDeps> = {}): FlushDeps {
  return {
    client,
    tableName: 't',
    logger: SILENT_LOGGER,
    operation: 'test.flush',
    scope: ['s'],
    ...extra,
  };
}

function pending(sortKey: string, over: Partial<PendingDelete> = {}): PendingDelete {
  return { key: { PK: 'p', SK: sortKey }, descriptors: [], ...over };
}

function offloaded(s3Key: string): PayloadDescriptor {
  return { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key };
}

const fakeOffloader = (): { deleteBatch: jest.Mock; ownsKey: () => boolean } => ({
  deleteBatch: jest.fn().mockResolvedValue([]),
  ownsKey: () => true,
});

/** The rejection a lost condition answers with, carrying the row that won. */
function refusal(row?: DocItem): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
    Item: row === undefined ? undefined : marshall(row),
  });
}

/** Refuse every delete, attaching the row so the decode reads it as a rewrite. */
function refuseAlways(input: DeleteCommandInput): never {
  throw refusal({ PK: 'p', SK: String(input.Key?.SK) });
}

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('flushPendingDeletes', () => {
  it('keeps at most DELETE_CONCURRENCY deletes in flight and still attempts every row', async () => {
    const { client, mock } = createStrictDocumentMock();
    let inFlight = 0;
    let peak = 0;
    let attempts = 0;
    mock.on(DeleteCommand).callsFake(async () => {
      attempts += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle();
      inFlight -= 1;
      return {};
    });
    const rows = Array.from({ length: 20 }, (_, i) => pending(`SK#${i}`));
    const tally = await flushPendingDeletes(deps(client), rows);
    expect(attempts).toBe(20);
    expect(peak).toBe(DELETE_CONCURRENCY);
    expect(tally.deleted).toBe(20);
  });

  it('releases the objects of a deleted row and none of a refused one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      if (input.Key?.SK === 'refused') throw refusal({ PK: 'p', SK: 'refused' });
      return {};
    });
    const offloader = fakeOffloader();
    const tally = await flushPendingDeletes(deps(client, { offloader: offloader as never }), [
      pending('kept', { descriptors: [offloaded('k-kept')] }),
      pending('refused', { descriptors: [offloaded('k-refused')] }),
    ]);
    expect(tally).toMatchObject({ deleted: 1, refused: 1, failures: [] });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-kept']);
  });

  it('names the unit of a refused row, and only of a row that has one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake(refuseAlways);
    const tally = await flushPendingDeletes(deps(client), [
      pending('a', { unit: '#c1' }),
      pending('b'),
    ]);
    expect(tally.refused).toBe(2);
    expect(tally.refusedUnits).toEqual(['#c1']);
  });

  it('reports a refusal instead of rejecting, so one row never stops the flush', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      if (input.Key?.SK === 'SK#0') throw refusal({ PK: 'p', SK: 'SK#0' });
      return {};
    });
    const warn = jest.fn();
    const rows = Array.from({ length: 12 }, (_, i) => pending(`SK#${i}`));
    const tally = await flushPendingDeletes(
      deps(client, { logger: { ...SILENT_LOGGER, warn } }),
      rows,
    );
    expect(tally).toMatchObject({ deleted: 11, refused: 1, failures: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /**
   * Synthetic, deliberately: nothing this library can do rewrites a chat
   * message row in place — every append draws a fresh id and so a fresh sort
   * key — so this branch is reached only by feeding the decode a rejection the
   * library would not produce. It is kept because the pin costs nothing on a
   * message row and because the "already gone" decode has to mean the same
   * thing there as everywhere else. A later reader who finds it never firing
   * in production should leave it alone.
   */
  it('decodes a refusal on a message row, which the library itself cannot produce', async () => {
    const { client, mock } = createStrictDocumentMock();
    const rewritten = { PK: 'p', SK: 'HISTORY#MSG#01A', message: { writeId: 'later' } };
    mock.on(DeleteCommand).callsFake(() => {
      throw refusal(rewritten);
    });
    const offloader = fakeOffloader();
    const tally = await flushPendingDeletes(deps(client, { offloader: offloader as never }), [
      pending('HISTORY#MSG#01A', {
        descriptors: [offloaded('k-msg')],
        guard: writeIdGuard('message', 'm1', 'writeId'),
      }),
    ]);
    expect(tally).toMatchObject({ deleted: 0, refused: 1 });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('counts a row that is already gone as deleted and releases its object', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake(() => {
      throw refusal();
    });
    const offloader = fakeOffloader();
    const tally = await flushPendingDeletes(deps(client, { offloader: offloader as never }), [
      pending('gone', { descriptors: [offloaded('k-gone')] }),
    ]);
    expect(tally).toMatchObject({ deleted: 1, refused: 0 });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-gone']);
  });

  it('records a genuine failure and starts no further row', async () => {
    const { client, mock } = createStrictDocumentMock();
    const denied = Object.assign(new Error('no'), { name: 'AccessDeniedException' });
    let attempts = 0;
    mock.on(DeleteCommand).callsFake(async (input: DeleteCommandInput) => {
      attempts += 1;
      if (input.Key?.SK === 'SK#0') throw denied;
      await settle();
      return {};
    });
    const rows = Array.from({ length: 40 }, (_, i) => pending(`SK#${i}`));
    const tally = await flushPendingDeletes(deps(client), rows);
    expect(tally.failures).toEqual([denied]);
    expect(attempts).toBe(DELETE_CONCURRENCY);
    /**
     * The rows already in flight when the failure lands are still counted:
     * `mapWithConcurrency` lets each worker finish the row it holds before it
     * stops taking new ones. Without this the pass would throw away deletes it
     * really did perform, and report less than it did.
     */
    expect(tally.deleted).toBe(DELETE_CONCURRENCY - 1);
  });

  /**
   * `unmarshall` is handed an `Item` that is already a plain document. The
   * stock document client does not produce one, so this is latent today — but
   * `client` is an eight-method duck type the package documents for callers to
   * wrap their own client with, which puts it in reach with no logger in the
   * path at all. Losing it meant `failures` stayed empty and the pass read that
   * as a clean flush.
   */
  it('records a throw from decoding the row a rejection carries', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      throw Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
        Item: { PK: 'p', SK: String(input.Key?.SK) },
      });
    });
    const tally = await flushPendingDeletes(deps(client), [pending('a')]);
    expect(tally).toMatchObject({ deleted: 0, refused: 0 });
    expect(tally.failures).toHaveLength(1);
  });

  /**
   * The refusal report calls the caller's own `Logger`, which is consumer code.
   * A throw there leaves the row settled but unreported, so it is filed as a
   * failure and not also counted as a refusal — one row, one outcome.
   */
  it('records a throw from the refusal report instead of reporting a clean flush', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).callsFake(refuseAlways);
    const warn = (): never => {
      throw new TypeError('logger transport closed');
    };
    const tally = await flushPendingDeletes(deps(client, { logger: { ...SILENT_LOGGER, warn } }), [
      pending('a'),
    ]);
    expect(tally).toMatchObject({ deleted: 0, refused: 0, refusedUnits: [] });
    expect(tally.failures).toHaveLength(1);
  });

  it('cleans nothing up when the adapter has no offloader', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const tally = await flushPendingDeletes(deps(client), [
      pending('a', { descriptors: [offloaded('k-a')] }),
    ]);
    expect(tally.deleted).toBe(1);
  });
});
