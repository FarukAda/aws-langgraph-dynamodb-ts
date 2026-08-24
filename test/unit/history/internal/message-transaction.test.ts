import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { writeMessageChunk } from '../../../../src/history/internal/message-transaction';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { MESSAGE_APPEND_RETRY_MAX_ATTEMPTS } from '../../../../src/shared/constants';
import { RetryExhaustedError } from '../../../../src/shared/errors/errors';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function transactionConflict(): Error {
  return Object.assign(new Error('canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'TransactionConflict' }],
  });
}

function messageItem(sk: string): ChatMessageItem {
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

describe('writeMessageChunk', () => {
  it('writes the metadata update and every message put in one transaction', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await writeMessageChunk(
      { client, tableName: 'history' } as never,
      [messageItem('MSG#1'), messageItem('MSG#2')],
      { sessionId: 's1', count: 2, now: 'u' },
    );
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items[0].Update?.UpdateExpression).toContain('ADD #count :n');
    expect(items[1].Put?.Item?.SK).toBe('MSG#1');
    expect(items[2].Put?.Item?.SK).toBe('MSG#2');
  });

  it('retries a transaction-conflict cancellation', async () => {
    const { client, mock } = createStrictDocumentMock();
    const conflict = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }],
    });
    mock.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});
    await writeMessageChunk(
      { client, tableName: 'history' } as never,
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it('does not retry a cancellation with a permanent reason', async () => {
    const { client, mock } = createStrictDocumentMock();
    const permanent = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ValidationError' }],
    });
    mock.on(TransactWriteCommand).rejects(permanent);
    await expect(
      writeMessageChunk(
        { client, tableName: 'history' } as never,
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toThrow();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not retry a bare cancellation that carries no reasons', async () => {
    const { client, mock } = createStrictDocumentMock();
    const bare = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
    });
    mock.on(TransactWriteCommand).rejects(bare);
    await expect(
      writeMessageChunk(
        { client, tableName: 'history' } as never,
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toThrow();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reuses one ClientRequestToken across retries so a re-sent commit is idempotent', async () => {
    const { client, mock } = createStrictDocumentMock();
    const conflict = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }],
    });
    mock.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});
    await writeMessageChunk(
      { client, tableName: 'history' } as never,
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    const calls = mock.commandCalls(TransactWriteCommand);
    const firstToken = calls[0].args[0].input.ClientRequestToken;
    expect(typeof firstToken).toBe('string');
    expect(calls[1].args[0].input.ClientRequestToken).toBe(firstToken);
  });

  it('uses a distinct ClientRequestToken for separate chunks', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const ctx = { client, tableName: 'history' } as never;
    await writeMessageChunk(ctx, [messageItem('MSG#1')], { sessionId: 's1', count: 1, now: 'u' });
    await writeMessageChunk(ctx, [messageItem('MSG#2')], { sessionId: 's1', count: 1, now: 'u' });
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls[0].args[0].input.ClientRequestToken).not.toBe(
      calls[1].args[0].input.ClientRequestToken,
    );
  });

  it('retries a sustained transaction conflict past the default 5-attempt budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    const survivedAttempts = MESSAGE_APPEND_RETRY_MAX_ATTEMPTS - 1;
    let call = mock.on(TransactWriteCommand);
    for (let i = 0; i < survivedAttempts; i++) {
      call = call.rejectsOnce(transactionConflict());
    }
    call.resolves({});
    await writeMessageChunk(
      { client, tableName: 'history' } as never,
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(survivedAttempts + 1);
  });

  it(`gives up after ${MESSAGE_APPEND_RETRY_MAX_ATTEMPTS} attempts under sustained conflict`, async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transactionConflict());
    await expect(
      writeMessageChunk(
        { client, tableName: 'history' } as never,
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(MESSAGE_APPEND_RETRY_MAX_ATTEMPTS);
  });
});
