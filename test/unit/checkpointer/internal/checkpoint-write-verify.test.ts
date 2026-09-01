import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { verifyCheckpointLanded } from '../../../../src/checkpointer/internal/checkpoint-write-verify';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../../../../src/checkpointer/types';
import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

const inline: PayloadDescriptor = {
  location: PayloadLocation.INLINE,
  serdeType: 'json',
  compressed: false,
  bytes: new Uint8Array([1]),
};

function s3(s3Key: string): PayloadDescriptor {
  return { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key };
}

function rows(metadata: PayloadDescriptor, checkpoint: PayloadDescriptor) {
  const meta: CheckpointMetaItem = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata,
  };
  const payload: CheckpointPayloadItem = { PK: 'CHKPT#t', SK: 'PAYLOAD##c1', checkpoint };
  return { meta, payload };
}

describe('verifyCheckpointLanded', () => {
  it("reports landed when the META row holds this attempt's metadata key", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { metadata: s3('k/meta/A') } });
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe('landed');
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'CHKPT#t', SK: 'META##c1' });
    expect(input.ConsistentRead).toBe(true);
    expect(input.ExpressionAttributeNames).toEqual({ '#d': 'metadata' });
  });

  it('probes the PAYLOAD row when only the checkpoint is offloaded', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { checkpoint: s3('k/ckpt/A') } });
    const { meta, payload } = rows(inline, s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe('landed');
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'CHKPT#t', SK: 'PAYLOAD##c1' });
    expect(input.ExpressionAttributeNames).toEqual({ '#d': 'checkpoint' });
  });

  it('reports not-landed when the row is absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
  });

  it("reports not-landed when the row holds another attempt's key", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { metadata: s3('k/meta/OTHER') } });
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
  });

  it('reports not-landed when the row holds an inline descriptor', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { metadata: inline } });
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
  });

  it('reports not-landed without reading when nothing was offloaded (nothing to clean up)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { meta, payload } = rows(inline, inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('reports unverified when the read itself fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'unverified',
    );
  });
});
