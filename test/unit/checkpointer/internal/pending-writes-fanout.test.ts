import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import {
  REGULAR_WRITE_CONCURRENCY,
  writeRegularRows,
} from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteRow } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

function item(index: number): CheckpointWriteRow {
  return {
    PK: 'CHKPT#t',
    SK: `WRITE##c1#task#${String(index).padStart(10, '0')}#ch`,
    taskId: 'task',
    index,
    channel: 'ch',
    writeGroup: 'G',
    occurrence: 0,
    value: {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: `k/${index}`,
    },
  };
}

/** A transport failure's real shape (`code`, not just `name`) — the way the SDK actually rejects. */
function transportTimeout(): Error {
  return Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
}

describe('writeRegularRows fan-out', () => {
  it(`keeps at most ${REGULAR_WRITE_CONCURRENCY} regular writes in flight, and settles every one`, async () => {
    const { client, mock } = createStrictDocumentMock();
    let inFlight = 0;
    let peak = 0;
    mock.on(TransactWriteCommand).callsFake(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return {};
    });
    const context: CheckpointerContext = {
      client,
      tableName: 'ckpt',
      serde,
      logger: SILENT_LOGGER,
      offloader: {} as never,
    };
    const items = Array.from({ length: 100 }, (_, index) => item(index));
    await expect(writeRegularRows(context, items)).resolves.toEqual({ deadUploads: [] });
    expect(peak).toBe(REGULAR_WRITE_CONCURRENCY);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(100);
  });

  it('does not send a write still queued behind the bound once the cancel fires, and settles one already in flight through the existing verification', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    let started = 0;
    const releases: Array<() => void> = [];
    mock.on(TransactWriteCommand).callsFake(() => {
      const callIndex = started;
      started += 1;
      // The cancel fires once the whole first batch is in flight, before any
      // of it has settled and before the item still queued behind the bound
      // has had a turn.
      if (started === REGULAR_WRITE_CONCURRENCY) controller.abort();
      return new Promise((resolve, reject) => {
        // The very first dispatch rejects with a value that never matters on
        // its own: the signal has already fired by the time it settles, so
        // `withRetry` reports it as ABORTED regardless of this reason,
        // exercising the settle logic below. Every other one in flight lands
        // normally.
        releases[callIndex] = () => (callIndex === 0 ? reject(transportTimeout()) : resolve({}));
      });
    });
    mock.on(GetCommand).resolves({});
    const context: CheckpointerContext = {
      client,
      tableName: 'ckpt',
      serde,
      logger: SILENT_LOGGER,
      offloader: {} as never,
    };
    const items = Array.from({ length: REGULAR_WRITE_CONCURRENCY + 1 }, (_, index) => item(index));
    const pending = writeRegularRows(context, items, controller.signal);
    // Let the first batch's dispatches reach the mock, and the cancel fire,
    // before releasing any of them.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(REGULAR_WRITE_CONCURRENCY);
    expect(controller.signal.aborted).toBe(true);
    releases.forEach((release) => release());
    const outcome = await pending;
    // The item still queued behind the bound when the cancel fired is never
    // sent at all, so its upload is dead.
    expect(outcome.deadUploads).toEqual([item(REGULAR_WRITE_CONCURRENCY)]);
    // The one already in flight when the cancel fired settles through the
    // existing verification: its row is still absent and an aborted write may
    // still land, so `settledVerdict` keeps its upload rather than releasing it.
    expect(outcome.error).toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(REGULAR_WRITE_CONCURRENCY);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });
});
