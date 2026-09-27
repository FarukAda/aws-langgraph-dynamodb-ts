import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

/** An offloader that offloads everything and records what it releases. */
function offloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

function contextWith(
  client: CheckpointerContext['client'],
  s3: ReturnType<typeof offloader>,
): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER, offloader: s3 as never };
}

/** The transport's own rejection of a request the caller's signal cut short. */
const cutShort = (controller: AbortController) => () => {
  controller.abort();
  return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
};

describe('putCheckpoint under a cancel', () => {
  it('keeps its uploads when the cancel cut the transaction short and the read finds nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(TransactWriteCommand).callsFake(cutShort(controller));
    mock.on(GetCommand).resolves({});
    const s3 = offloader();
    await expect(
      putCheckpoint(
        contextWith(client, s3),
        { configurable: { thread_id: 't1' }, signal: controller.signal },
        checkpoint,
        metadata,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(s3.deleteBatch).not.toHaveBeenCalled();
  });

  it('releases its uploads and sends nothing when the cancel came before the write', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    const s3 = {
      ...offloader(),
      upload: (key: string) => {
        controller.abort();
        return key;
      },
    };
    await expect(
      putCheckpoint(
        contextWith(client, s3),
        { configurable: { thread_id: 't1' }, signal: controller.signal },
        checkpoint,
        metadata,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(s3.deleteBatch).toHaveBeenCalledTimes(1);
  });

  it('still releases its uploads when a failure the service answered is confirmed not to have landed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('bad'), {
        name: 'ValidationException',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    mock.on(GetCommand).resolves({});
    const s3 = offloader();
    await expect(
      putCheckpoint(
        contextWith(client, s3),
        { configurable: { thread_id: 't1' } },
        checkpoint,
        metadata,
      ),
    ).rejects.toMatchObject({ name: 'ValidationException' });
    expect(s3.deleteBatch).toHaveBeenCalledTimes(1);
  });
});
