import { BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

function trackingOffloader(upload: (key: string) => Promise<string> = async (key) => key) {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

/**
 * Special (negative-index) write behavior split out of put-writes.test.ts to
 * stay under the test file line cap. Covers the compare-and-swap path
 * (`special-write-cas.ts`) as exercised through the public `putWrites` entry
 * point, alongside `special-write-cas.test.ts`'s unit-level coverage.
 */
describe('putWrites special (negative-index) writes', () => {
  it("cleans up a special item's never-committed upload when its write hard-fails outright", async () => {
    // A bare SDK-level rejection (not a ConditionalCheckFailedException) is
    // reported directly by writeSpecialItem's outcome — no reconstruction
    // needed, unlike the old UnprocessedItems accounting.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
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

  it('still cleans up a failed regular write when the special path fails before its own conditional put is attempted', async () => {
    // Regression: a readSpecialRow rejection used to short-circuit
    // Promise.all before this regular write's own failed-upload cleanup ran.
    // It also cleans up the special write's own never-committed upload: the
    // read failing means the conditional put was never even attempted, so
    // that upload is unambiguously never-committed.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('get'), { name: 'ValidationException' }));
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
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
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(2);
    const keysCalled = offloader.deleteBatch.mock.calls.map((call) => (call[0] as string[])[0]);
    expect(keysCalled).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^t\/\/c1\/task-1\/write-0\/ch\/[^/]+$/),
        expect.stringMatching(/^t\/\/c1\/task-1\/write--1\/__error__\/[^/]+$/),
      ]),
    );
  });

  it('uses an individual conditional PutCommand for special (negative-index) writes, never BatchWriteItem', async () => {
    // BatchWriteItem cannot carry per-request conditions, which is why the
    // compare-and-swap on special writes must issue its own PutCommand. An
    // offloader is configured so the compare-and-swap path (rather than its
    // no-offloader unconditional-put shortcut) is the one under test.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const ctx = { ...context(client), offloader: trackingOffloader() as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['__error__', 'boom']],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(mock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });

  it('overwrites an existing special row, guarded on the writeGroup it observed', async () => {
    // Proves the special-write path really does overwrite an existing row
    // (matching every reference checkpointer) rather than only ever hitting
    // the attribute_not_exists(PK) first-write branch above.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: { s3Key: 'old.bin' }, writeGroup: 'earlier' } });
    mock.on(PutCommand).resolves({});
    const ctx = { ...context(client), offloader: trackingOffloader() as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['__error__', 'boom']],
      'task-1',
    );
    const calls = mock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ConditionExpression).toBe('#rev = :rev');
    expect(calls[0].args[0].input.ExpressionAttributeValues).toEqual({ ':rev': 'earlier' });
  });

  it('dispatches special and regular writes from the same call, each through its own conditional PutCommand', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
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
    const calls = mock.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    // Regular writes guard first-write-wins with ReturnValuesOnConditionCheckFailure;
    // special writes guard on the observed writeGroup instead, so they never set it.
    const regular = calls.find((call) => (call.args[0].input.Item as { index: number }).index >= 0);
    const special = calls.find((call) => (call.args[0].input.Item as { index: number }).index < 0);
    expect(regular?.args[0].input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(special?.args[0].input.ReturnValuesOnConditionCheckFailure).toBeUndefined();
  });

  it('dedupes duplicate writes to the same special channel by sort key before writing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
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
    mock.on(PutCommand).resolves({});
    const upload = jest.fn(async (key: string) => key);
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
    mock.on(GetCommand).callsFake(async () => {
      const puts = mock.commandCalls(PutCommand);
      if (puts.length === 0) return {};
      const written = puts[puts.length - 1].args[0].input.Item as {
        writeGroup: string;
        value: unknown;
      };
      return { Item: { value: written.value, writeGroup: written.writeGroup } };
    });
    mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
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
