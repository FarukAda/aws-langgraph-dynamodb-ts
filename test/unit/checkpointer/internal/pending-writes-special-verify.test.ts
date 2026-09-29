import { GetCommand } from '@aws-sdk/lib-dynamodb';

import {
  readSpecialRow,
  specialRowProbe,
  verifyAfterFailure,
} from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteRow } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  };
}

const descriptor = {
  location: 'INLINE',
  serdeType: 'json',
  schemaVersion: 1,
  compressed: false,
} as never as import('../../../../src/shared/codec/codec').PayloadDescriptor;

const item = (over: Partial<CheckpointWriteRow> = {}): CheckpointWriteRow =>
  ({
    PK: 'CHKPT#t',
    SK: 'WRITE##c1#task-1#-0000000001#__interrupt__',
    taskId: 'task-1',
    channel: '__interrupt__',
    writeGroup: 'group-a',
    value: descriptor,
    ...over,
  }) as CheckpointWriteRow;

/**
 * A cancellation carrying the row that turned the write away, in the
 * attribute-value form the SDK attaches it in.
 */
function conditionFailure(group?: string): Error {
  const error = new Error('The conditional request failed') as Error & {
    name: string;
    Item?: Record<string, unknown>;
  };
  error.name = 'ConditionalCheckFailedException';
  if (group !== undefined) {
    error.Item = {
      writeGroup: { S: group },
      value: {
        M: {
          location: { S: 'INLINE' },
          serdeType: { S: 'json' },
          schemaVersion: { N: '1' },
          compressed: { BOOL: false },
        },
      },
    };
  }
  return error;
}

describe('specialRowProbe', () => {
  it('recognises the write by its own group and asks for the descriptor too', () => {
    expect(specialRowProbe(item())).toEqual({
      key: { PK: 'CHKPT#t', SK: 'WRITE##c1#task-1#-0000000001#__interrupt__' },
      kind: 'attribute',
      attribute: 'writeGroup',
      expected: 'group-a',
      also: ['value'],
    });
  });
});

describe('readSpecialRow', () => {
  it('reports the row s descriptor and the group guarding it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'group-b', value: descriptor } });
    await expect(readSpecialRow(context(client), item())).resolves.toEqual({
      exists: true,
      revision: 'group-b',
      value: descriptor,
    });
  });

  it('reports an absent row as the state a first writer pins to', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(readSpecialRow(context(client), item())).resolves.toEqual({ exists: false });
  });

  /** Not swallowed: the caller reports the failure with its own cause. */
  it('rejects when the read fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(new Error('boom'));
    await expect(readSpecialRow(context(client), item())).rejects.toThrow(/boom/);
  });
});

describe('verifyAfterFailure', () => {
  const attempted = { exists: true, value: descriptor, revision: 'group-old' };

  /** A rejection carrying the row costs no read at all. */
  it('settles a guard rejection from the row the exception carried', async () => {
    const { client, mock } = createStrictDocumentMock();
    const failure = conditionFailure('group-b');
    const verified = await verifyAfterFailure(context(client), item(), attempted, failure);
    expect(verified.outcome).toMatchObject({ committed: false });
    expect(verified.observed).toEqual({ exists: true, revision: 'group-b', value: descriptor });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('reports a commit when the row carries this write s own group', async () => {
    const { client, mock } = createStrictDocumentMock();
    const failure = conditionFailure('group-a');
    const verified = await verifyAfterFailure(context(client), item(), attempted, failure);
    expect(verified.outcome).toEqual({ committed: true, superseded: descriptor });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  /** A lost response carries no row, so the read is spent here and only here. */
  it('reads the row back for a failure that carries none', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'group-a' } });
    const verified = await verifyAfterFailure(
      context(client),
      item(),
      attempted,
      new Error('timeout'),
    );
    expect(verified.outcome).toEqual({ committed: true, superseded: descriptor });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  /**
   * Nothing is confirmed, so the outcome reports a commit and keeps the
   * originating error: leaking one object beats stranding a live row.
   */
  it('reports a commit and keeps the error when the verification read fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(new Error('partition unreachable'));
    const trigger = new Error('timeout');
    const verified = await verifyAfterFailure(context(client), item(), attempted, trigger);
    expect(verified.outcome).toEqual({ committed: true, error: trigger });
    expect(verified.observed).toBeUndefined();
  });

  it('reports a confirmed non-commit when the row is gone', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const trigger = new Error('timeout');
    const verified = await verifyAfterFailure(context(client), item(), attempted, trigger);
    expect(verified.outcome).toEqual({ committed: false, error: trigger });
    expect(verified.observed).toEqual({ exists: false });
  });

  /**
   * Another writer holds the row, so this item's upload is dead: its key ends in
   * this call's own group, which that writer's row does not name. The outcome
   * carries nothing about the live row's value; the row comes back only as the
   * state a compare-and-swap re-pins to. Both doors agree: the row a rejection
   * returned, and a read.
   */
  it('reports a confirmed non-commit, and the row to re-pin to, when another writer holds it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'group-b', value: descriptor } });
    const trigger = new Error('timeout');
    const rejection = conditionFailure('group-b');
    const read = await verifyAfterFailure(context(client), item(), attempted, trigger);
    const rejected = await verifyAfterFailure(context(client), item(), attempted, rejection);
    const holder = { exists: true, value: descriptor, revision: 'group-b' };
    expect(read).toEqual({ outcome: { committed: false, error: trigger }, observed: holder });
    expect(rejected).toEqual({ outcome: { committed: false, error: rejection }, observed: holder });
  });
  /**
   * The attempt is cut short in transit, so it may still arrive. What decides
   * the upload's fate is whether the row still satisfies the condition that
   * attempt carries.
   */
  describe('an attempt cut short', () => {
    const cutShort = (): Error =>
      Object.assign(new Error('socket timed out'), { name: 'TimeoutError' });
    const noRevision = { exists: true, value: descriptor };

    /**
     * A row pinned to "no revision" is guarded by `attribute_not_exists`, which
     * an absent row satisfies too: a row deleted in between (by deleteThread or
     * the TTL sweep) is still one the in-flight attempt can create, naming this
     * upload.
     */
    it('keeps the upload when a "no revision" pin finds the row absent', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(GetCommand).resolves({});
      const trigger = cutShort();
      const verified = await verifyAfterFailure(context(client), item(), noRevision, trigger);
      expect(verified).toEqual({ outcome: { committed: true, error: trigger } });
    });

    it('releases the upload when a "no revision" pin finds the row at another revision', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(GetCommand).resolves({ Item: { writeGroup: 'group-b', value: descriptor } });
      const trigger = cutShort();
      const verified = await verifyAfterFailure(context(client), item(), noRevision, trigger);
      expect(verified).toEqual({
        outcome: { committed: false, error: trigger },
        observed: { exists: true, revision: 'group-b', value: descriptor },
      });
    });

    it('releases the upload when a `#rev = :rev` pin finds the row absent', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(GetCommand).resolves({});
      const trigger = cutShort();
      const verified = await verifyAfterFailure(context(client), item(), attempted, trigger);
      expect(verified).toEqual({
        outcome: { committed: false, error: trigger },
        observed: { exists: false },
      });
    });

    /** The unconditional overwrite can land over any row, a third writer's included. */
    it('keeps the upload when an overwrite finds a third writer s group', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(GetCommand).resolves({ Item: { writeGroup: 'group-c', value: descriptor } });
      const trigger = cutShort();
      const verified = await verifyAfterFailure(context(client), item(), attempted, trigger, false);
      expect(verified).toEqual({ outcome: { committed: true, error: trigger } });
    });
  });
});
