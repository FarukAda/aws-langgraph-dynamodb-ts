import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';

import { addMessages } from '../../../../src/history/actions/add-messages';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function sequentialUlid(): () => string {
  let n = 0;
  return () => `U${n++}`;
}

function context(
  client: HistoryContext['client'],
  extra?: Partial<HistoryContext>,
): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: sequentialUlid(),
    onCorruptMessage: 'skip',
    ...extra,
  };
}

describe('addMessages', () => {
  it('writes one item per message and the count in a single transaction', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client), 's1', [new HumanMessage('a'), new AIMessage('b')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items[0].Update?.UpdateExpression).toContain('ADD #count :n');
    expect(items[0].Update?.ExpressionAttributeValues?.[':n']).toBe(2);
    expect(items[0].Update?.ExpressionAttributeValues?.[':title']).toBe('a');
    expect(items[1].Put?.Item?.SK).toBe('HISTORY#MSG#U0');
    expect(items[2].Put?.Item?.SK).toBe('HISTORY#MSG#U1');
  });

  it('cleans up already-uploaded S3 objects when a later message fails to encode (I5)', async () => {
    // buildItems uploads sequentially with no try/catch, ahead of the append
    // saga's compensation machinery — so a failure on message N left messages
    // 1..N-1's objects with no cleanup path at all, despite the rest of this
    // subsystem guaranteeing no orphans.
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    let uploads = 0;
    const deleteBatch = jest.fn().mockResolvedValue([]);
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: async (key: string) => {
        uploads += 1;
        if (uploads === 2) throw new Error('upload failed');
        return key;
      },
      deleteBatch,
    };
    await expect(
      addMessages(context(client, { offloader: offloader as never }), 's1', [
        new HumanMessage('first'),
        new HumanMessage('second'),
      ]),
    ).rejects.toThrow('upload failed');
    expect(deleteBatch).toHaveBeenCalledWith(['s1/U0']);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rethrows an encode failure untouched when no offloader is configured (I5)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const serde = {
      dumpsTyped: async (): Promise<[string, Uint8Array]> => {
        throw new Error('serde failed');
      },
      loadsTyped: async (): Promise<unknown> => ({}),
    };
    await expect(
      addMessages(context(client, { serde }), 's1', [new HumanMessage('a')]),
    ).rejects.toThrow('serde failed');
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a message the read side could never rebuild before touching DynamoDB (HIST-04)', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(
      addMessages(context(client), 's1', [new HumanMessage('a'), new RemoveMessage({ id: 'x' })]),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      message: expect.stringContaining('remove'),
    });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('omits the title clause when there is no human message', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client), 's1', [new AIMessage('only assistant')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[0].Update?.UpdateExpression).not.toContain('#title');
  });

  it('is a no-op for an empty message list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await addMessages(context(client), 's1', []);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects an empty session id', async () => {
    const { client } = createStrictDocumentMock();
    await expect(addMessages(context(client), '', [new HumanMessage('hi')])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('resolves the shared ttl anchor and stamps it on every item and the session update', async () => {
    const { client, mock } = createStrictDocumentMock();
    const future = Math.floor(Date.now() / 1000) + 10_000;
    mock.on(GetCommand).resolves({ Item: { ttl: future } });
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 's1', [
      new HumanMessage('hi'),
      new AIMessage('yo'),
    ]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const update = items[0].Update;
    expect(update?.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
    expect(update?.ExpressionAttributeValues?.[':ttl']).toBe(future);
    const puts = items.slice(1);
    expect(puts.every((p) => p.Put?.Item?.ttl === future)).toBe(true);
  });

  it('force-refreshes the session ttl anchor via a plain SET when the stored anchor is missing or expired', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    await addMessages(context(client, { ttl: { seconds: 100 } }), 's1', [new HumanMessage('hi')]);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const update = items[0].Update;
    expect(update?.UpdateExpression).toContain('#ttl = :ttl');
    expect(update?.UpdateExpression).not.toContain('if_not_exists(#ttl');
  });

  it('splits past the per-transaction limit into multiple transactions with a correct total count', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const many = Array.from({ length: 150 }, (_unused, index) => new HumanMessage(`m${index}`));
    await addMessages(context(client), 's1', many);
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    const counts = calls.map(
      (call) =>
        (call.args[0].input.TransactItems ?? [])[0].Update?.ExpressionAttributeValues?.[':n'],
    );
    expect(counts).toEqual([99, 51]);
    expect(counts[0] + counts[1]).toBe(150);
  });

  it('rethrows a transaction failure without cleanup when no offloader is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(addMessages(context(client), 's1', [new HumanMessage('hi')])).rejects.toThrow(
      'down',
    );
  });

  it('cleans up offloaded objects when the transaction fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: string[]) => parts.join('/'),
      upload: async (key: string) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    await expect(
      addMessages(context(client, { offloader: offloader as never }), 's1', [
        new HumanMessage('hi'),
      ]),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['s1/U0']);
  });
});
