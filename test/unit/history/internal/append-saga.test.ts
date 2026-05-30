import { BatchWriteCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { appendChunks } from '../../../../src/history/internal/append-saga';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { CompensationFailedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function inlineItem(sk: string): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    },
  };
}

function s3Item(sk: string, s3Key: string): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: { location: PayloadLocation.S3, serdeType: 'json', s3Key },
  };
}

function context(client: unknown, offloader?: unknown, logger: unknown = SILENT_LOGGER) {
  return { client, tableName: 'history', logger, offloader } as never;
}

describe('appendChunks', () => {
  it('commits every chunk in order and never rolls back on success', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await appendChunks(context(client), 's1', [[inlineItem('MSG#1')], [inlineItem('MSG#2')]], {
      now: 'u',
    });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rolls back committed chunks and reverts the count when a later chunk fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await expect(
      appendChunks(
        context(client, undefined, logger),
        's1',
        [[inlineItem('MSG#1'), inlineItem('MSG#2')], [inlineItem('MSG#3')]],
        { now: 'u' },
      ),
    ).rejects.toThrow('boom');

    const deletes =
      mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.history ?? [];
    expect(deletes.map((r) => r.DeleteRequest?.Key?.SK)).toEqual(['MSG#1', 'MSG#2']);
    const revert = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(revert.UpdateExpression).toBe('ADD #count :neg');
    expect(revert.ExpressionAttributeValues?.[':neg']).toBe(-2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('compensating'), {
      sessionId: 's1',
      committedChunks: 1,
    });
  });

  it('raises CompensationFailedError when the rollback itself fails', async () => {
    expect(CompensationFailedError).toBeDefined();
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('rollback-down'), { name: 'ValidationException' }));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await expect(
      appendChunks(
        context(client, undefined, logger),
        's1',
        [[inlineItem('MSG#1')], [inlineItem('MSG#2')]],
        { now: 'u' },
      ),
    ).rejects.toMatchObject({ name: 'CompensationFailedError', code: 'COMPENSATION_FAILED' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rollback failed'),
      expect.objectContaining({ sessionId: 's1' }),
    );
  });

  it('cleans offloaded S3 objects for the whole batch when a chunk fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('x'), { name: 'ValidationException' }));
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(
        context(client, offloader),
        's1',
        [[s3Item('MSG#1', 'k1'), s3Item('MSG#2', 'k2')]],
        {
          now: 'u',
        },
      ),
    ).rejects.toThrow('x');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k1', 'k2']);
  });
});
