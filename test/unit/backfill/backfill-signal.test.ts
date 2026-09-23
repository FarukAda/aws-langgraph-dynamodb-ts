import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { backfillRecencyIndex } from '../../../src/backfill/backfill';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

/**
 * `backfillRecencyIndex` takes a signal in two places: its own `signal`, and
 * `retry.signal`, part of the full retry surface it accepts. Both cancel the
 * run. The top-level one wins when both are given, since it is the caller's
 * handle on the whole operation.
 */

const TABLE = 'tbl';
const session = {
  PK: 'HIST#s1',
  SK: 'HISTORY#SESSION',
  sessionId: 's1',
  updatedAt: '2026-02-02T00:00:00.000Z',
};
const throttle = (): Error =>
  Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const aborted = { code: ErrorCode.ABORTED, name: 'DynamoDBLangGraphError' };

describe('backfillRecencyIndex retry.signal', () => {
  /** It was validated and then overwritten by the absent top-level signal: three scans, then `RETRY_EXHAUSTED`. */
  it('cancels the run when no top-level signal is given, before any scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).rejects(throttle());
    await expect(
      backfillRecencyIndex({
        client,
        tableName: TABLE,
        retry: { maxAttempts: 3, rng: () => 0, signal: abortedSignal() },
      }),
    ).rejects.toMatchObject(aborted);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('cancels the index writes too, not only the scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(ScanCommand).callsFake(() => {
      controller.abort();
      return { Items: [session] };
    });
    mock.on(UpdateCommand).resolves({});
    await expect(
      backfillRecencyIndex({ client, tableName: TABLE, retry: { signal: controller.signal } }),
    ).rejects.toMatchObject(aborted);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('backfillRecencyIndex signal precedence', () => {
  it('cancels on an aborted top-level signal beside a live retry.signal', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(
      backfillRecencyIndex({
        client,
        tableName: TABLE,
        signal: abortedSignal(),
        retry: { signal: new AbortController().signal },
      }),
    ).rejects.toMatchObject(aborted);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('runs on a live top-level signal beside an aborted retry.signal', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [session] });
    mock.on(UpdateCommand).resolves({});
    await expect(
      backfillRecencyIndex({
        client,
        tableName: TABLE,
        signal: new AbortController().signal,
        retry: { signal: abortedSignal() },
      }),
    ).resolves.toEqual({ scanned: 1, indexed: 1, skipped: 0 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(1);
  });
});
