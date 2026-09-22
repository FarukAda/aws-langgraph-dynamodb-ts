import { GetCommand } from '@aws-sdk/lib-dynamodb';

import {
  ancestorExpired,
  probeAncestor,
} from '../../../../src/checkpointer/internal/ancestor-probe';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { MAX_LOGGED_LABELS, MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  };
}

const parent = { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'c1' } };

describe('probeAncestor', () => {
  it('reads the ancestor at the key its config names', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'CHKPT#t', SK: 'META##c1' } });
    const stop = await probeAncestor(context(client), parent);
    expect(stop).toEqual({ threadId: 't', checkpointId: 'c1', expired: false });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'CHKPT#t',
      SK: 'META##c1',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  /**
   * The whole point of this read: an ancestor that exists but has expired is
   * data loss, while one that was never written is an ordinary root.
   */
  it('reports an expired ancestor as present, unlike every other read', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'CHKPT#t', SK: 'META##c1', ttl: 1 } });
    await expect(probeAncestor(context(client), parent)).resolves.toMatchObject({ expired: true });
  });

  it('reports a checkpoint that was never written as present-but-not-expired', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(probeAncestor(context(client), parent)).resolves.toMatchObject({ expired: false });
  });

  /** A pointer naming no thread or no checkpoint addresses nothing that could have expired. */
  it('answers undefined, without a read, for a config naming no thread or checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(probeAncestor(context(client), { configurable: {} })).resolves.toBeUndefined();
    await expect(
      probeAncestor(context(client), { configurable: { thread_id: 't' } }),
    ).resolves.toBeUndefined();
    await expect(
      probeAncestor(context(client), { configurable: { checkpoint_id: 'c1' } }),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('defaults the namespace to the root one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await probeAncestor(context(client), {
      configurable: { thread_id: 't', checkpoint_id: 'c1' },
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toMatchObject({ SK: 'META##c1' });
  });
});

describe('ancestorExpired', () => {
  const error = ancestorExpired({ threadId: 't', checkpointId: 'c1', expired: true }, ['messages']);

  it('carries the code, the thread and the checkpoint a caller branches on', () => {
    expect(error.code).toBe(ErrorCode.ANCESTOR_EXPIRED);
    expect(error.context).toMatchObject({ threadId: 't', checkpointId: 'c1' });
  });

  /** The message has to say which channel was lost and what to change. */
  it('names the channels and the setting that prevents it', () => {
    expect(error.message).toContain('"messages"');
    expect(error.message).toContain('snapshotFrequency');
  });

  /**
   * The walk's cursor is a row's own `parentConfig` after the first hop, so
   * the checkpoint and thread it names come off a row. `channels` is checked
   * for being an array of strings and for nothing else. `context` keeps both
   * identifiers whole, because that is what a caller branches on.
   */
  it('bounds the identifiers and the channel list it quotes', () => {
    const checkpointId = 'c'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const threadId = 't'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const channels = Array.from({ length: MAX_LOGGED_LABELS + 5 }, (_unused, at) => `ch${at}`);
    const bounded = ancestorExpired({ checkpointId, threadId, expired: true }, channels);
    expect(bounded.context).toMatchObject({ threadId, checkpointId });
    expect(bounded.message).not.toContain(checkpointId);
    expect(bounded.message).not.toContain(threadId);
    expect(bounded.message).toContain(truncateForLog(checkpointId));
    expect(bounded.message).toContain(truncateForLog(threadId));
    expect(bounded.message).toContain(`"ch${MAX_LOGGED_LABELS - 1}"`);
    expect(bounded.message).not.toContain(`"ch${MAX_LOGGED_LABELS}"`);
    expect(bounded.message).toContain(`…(len ${channels.length})`);
  });
});
