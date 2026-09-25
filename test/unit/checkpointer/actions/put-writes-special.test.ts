import { BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  committedRows,
  createStrictDocumentMock,
  rejectRowWrites,
  resolveRowWrites,
  rowWriteInputs,
} from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

/**
 * The default `upload` is typed `Promise<string>` and never throws, so
 * returning `Promise.resolve(key)` already has that type without `async`.
 */
function trackingOffloader(
  upload: (key: string) => Promise<string> = (key) => Promise.resolve(key),
) {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

/**
 * Special (negative-index) write behavior, kept apart from put-writes.test.ts
 * because it takes a different path. Covers the compare-and-swap path
 * (`pending-writes.ts`) as exercised through the public `putWrites` entry
 * point, alongside `pending-writes-special.test.ts`'s unit-level coverage.
 */
describe('putWrites special (negative-index) writes', () => {
  it("cleans up a special item's never-committed upload when its write hard-fails outright", async () => {
    // A bare SDK-level rejection (not a ConditionalCheckFailedException) is
    // reported directly by writeSpecialRow's outcome — no reconstruction
    // needed, unlike the old UnprocessedItems accounting.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    rejectRowWrites(mock, Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    await expect(
      putWrites(
        ctx,
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['__error__', 'boom']],
        'task-1',
      ),
    ).rejects.toMatchObject({ name: 'ValidationException', message: 'boom' });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t\/\/c1\/task-1\/write--1\/__error__\/[^/]+$/);
  });

  it('still cleans up a failed regular write, and keeps the special upload, when the special path fails before its own conditional put is attempted', async () => {
    // Regression: a readSpecialRow rejection used to short-circuit
    // Promise.all before this regular write's own failed-upload cleanup ran.
    // The special write's own upload is kept: its put was never attempted, but
    // the failed read establishes nothing about the row, which a racer that
    // wrote the same value may already hold under that very key. The
    // regular write's own post-failure verification read must succeed (row
    // absent) for its upload to count as confirmed dead, so only the special
    // row's read is failed.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).callsFake((input: { Key: { SK: string } }) => {
      if (input.Key.SK.includes('#0000000007#')) {
        throw Object.assign(new Error('get'), { name: 'ValidationException' });
      }
      return {};
    });
    rejectRowWrites(mock, Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    await expect(
      putWrites(
        ctx,
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [
          ['ch', 'a'],
          ['__error__', 'boom'],
        ],
        'task-1',
      ),
    ).rejects.toThrow('get');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([
      expect.stringMatching(/^t\/\/c1\/task-1\/write-0\/ch\/[^/]+$/),
    ]);
  });

  it('uses an individual conditional write for special (negative-index) writes, never BatchWriteItem', async () => {
    // BatchWriteItem cannot carry per-request conditions, which is why the
    // compare-and-swap on special writes must issue its own write. An
    // offloader is configured so the compare-and-swap path (rather than its
    // no-offloader unconditional-put shortcut) is the one under test; which
    // shape that write then takes is pinned in pending-writes-special-token.test.ts.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    resolveRowWrites(mock);
    const ctx = { ...context(client), offloader: trackingOffloader() as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['__error__', 'boom']],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(rowWriteInputs(mock)).toHaveLength(1);
    expect(rowWriteInputs(mock)[0].ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('overwrites an existing special row, guarded on the writeGroup it observed', async () => {
    // Proves the special-write path really does overwrite an existing row
    // (matching every reference checkpointer) rather than only ever hitting
    // the attribute_not_exists(PK) first-write branch above.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: { s3Key: 'old.bin' }, writeGroup: 'earlier' } });
    resolveRowWrites(mock);
    const ctx = { ...context(client), offloader: trackingOffloader() as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['__error__', 'boom']],
      'task-1',
    );
    const puts = rowWriteInputs(mock);
    expect(puts).toHaveLength(1);
    expect(puts[0].ConditionExpression).toBe('#rev = :rev');
    expect(puts[0].ExpressionAttributeValues).toEqual({ ':rev': 'earlier' });
  });

  it('dispatches special and regular writes from the same call, each through its own conditional write', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    resolveRowWrites(mock);
    const ctx = { ...context(client), offloader: trackingOffloader() as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['ch', 'a'],
        ['__error__', 'boom'],
      ],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    const puts = rowWriteInputs(mock);
    expect(puts).toHaveLength(2);
    // Regular writes guard first-write-wins with ReturnValuesOnConditionCheckFailure;
    // special writes guard on the observed writeGroup instead, so they never set it.
    const indexOf = (put: (typeof puts)[number]) => (put.Item as { index: number }).index;
    expect(puts.find((put) => indexOf(put) >= 0)?.ReturnValuesOnConditionCheckFailure).toBe(
      'ALL_OLD',
    );
    // Special writes ask for it too, so a lost compare-and-swap re-pins from the exception.
    expect(puts.find((put) => indexOf(put) < 0)?.ReturnValuesOnConditionCheckFailure).toBe(
      'ALL_OLD',
    );
  });

  it('dedupes duplicate writes to the same special channel by sort key before writing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['__error__', 'first'],
        ['__error__', 'second'],
      ],
      'task-1',
    );
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it('never uploads the discarded duplicate special write (fixes the leak, not just the DynamoDB row)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    resolveRowWrites(mock);
    const upload = jest.fn((key: string) => Promise.resolve(key));
    const ctx = { ...context(client), offloader: trackingOffloader(upload) as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['__error__', 'first'],
        ['__error__', 'second'],
      ],
      'task-1',
    );
    // Only the surviving (last) write should ever be encoded/uploaded — the
    // discarded first duplicate must never reach the offloader at all.
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('never deletes the S3 object of a special row whose write is not confirmed to have failed', async () => {
    // The guarded put commits server-side, its response is lost, and every
    // re-issue times out at the transport, so the budget is spent without a
    // ConditionalCheckFailedException. Treating that as a confirmed
    // non-commit deleted the object the now-live row points at, making every
    // later getTuple() on the checkpoint fail with S3 NoSuchKey, permanently.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).callsFake(() => {
      const rows = committedRows(mock);
      if (rows.length === 0) return {};
      const written = rows[rows.length - 1] as { writeGroup: string; value: unknown };
      return { Item: { value: written.value, writeGroup: written.writeGroup } };
    });
    rejectRowWrites(mock, Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    await expect(
      putWrites(
        ctx,
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['__error__', 'boom']],
        'task-1',
      ),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
});
