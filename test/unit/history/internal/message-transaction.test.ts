import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { writeMessageChunk } from '../../../../src/history/internal/message-transaction';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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
});
