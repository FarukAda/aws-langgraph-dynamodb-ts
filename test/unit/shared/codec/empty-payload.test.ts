import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { encodePayload } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** A serde that serialises everything to nothing, as the default one does for a function. */
const emptySerde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

const options = { keyParts: ['t', 'c'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } };

/**
 * Zero bytes is not JSON, so a row holding them is written happily and can
 * never be read again: every later read of the checkpoint it belongs to fails
 * on the parse. The store's own serializer already refuses these values; this
 * is the same refusal one layer down, where every adapter passes.
 */
describe('encodePayload refuses a payload that serialises to nothing', () => {
  it('names `value`, and keeps it apart from the payload that is too large', async () => {
    const error = await encodePayload('anything', { serde: emptySerde }, options).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.VALIDATION,
      context: { field: 'value' },
    });
    expect((error as Error).message).toContain('zero bytes');
  });

  /** Refused before the upload, so nothing is stored for a payload nothing can read. */
  it('uploads no object for it', async () => {
    const offloader = {
      shouldOffload: jest.fn().mockReturnValue(true),
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: jest.fn(),
      assertOwnedKey: () => undefined,
    };
    await expect(
      encodePayload('anything', { serde: emptySerde, offloader: offloader as never }, options),
    ).rejects.toMatchObject({ context: { field: 'value' } });
    expect(offloader.upload).not.toHaveBeenCalled();
    expect(offloader.shouldOffload).not.toHaveBeenCalled();
  });

  /** Before compression too, so an inline and an offloaded payload answer alike. */
  it('refuses it whether or not compression is configured', async () => {
    await expect(
      encodePayload(
        'anything',
        { serde: emptySerde, compression: { enabled: true, minSizeBytes: 0 } },
        options,
      ),
    ).rejects.toMatchObject({ context: { field: 'value' } });
  });
});

/**
 * The repro: a pending write whose value is a function. Under the default
 * `JsonPlusSerializer` it serialises to zero bytes, was written with an
 * ordinary `INLINE` descriptor, and every later `getTuple` of that checkpoint
 * then failed with a wrapped `SyntaxError`.
 */
describe('a function-valued pending write', () => {
  it('is refused, and no row is written for it', async () => {
    const { client, mock } = createStrictDocumentMock();
    /** Every write resolves, so a row that is written is a row that lands. */
    mock.on(GetCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    mock.on(PutCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client });
    await expect(
      saver.putWrites(
        { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'c1' } },
        [['ch', () => 1]],
        'task',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'value' } });
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
