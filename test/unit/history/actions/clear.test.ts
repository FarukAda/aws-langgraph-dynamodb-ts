import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import { clearSession } from '../../../../src/history/actions/clear';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(
  client: HistoryContext['client'],
  extra?: Partial<HistoryContext>,
): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER, ...extra };
}

describe('clearSession', () => {
  it('does nothing when the session does not exist', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await clearSession(context(client), 'sess-x');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('deletes the session item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        messages: { location: PayloadLocation.INLINE, serdeType: 'json', bytes: new Uint8Array() },
      },
    });
    mock.on(DeleteCommand).resolves({});
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({
      PK: 'sess-1',
      SK: 'SESSION',
    });
  });

  it('cleans up the offloaded S3 object when the messages were offloaded', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        messages: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'sess-1/messages.bin' },
      },
    });
    mock.on(DeleteCommand).resolves({});
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await clearSession(context(client, { offloader: offloader as never }), 'sess-1');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['sess-1/messages.bin']);
  });
});
