import type { StoredMessage } from '@langchain/core/messages';

import { buildMessageItem, narrowMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { decodePayload, PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

function context(): HistoryContext {
  return {
    client: {} as never,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
  };
}

const stored: StoredMessage = { type: 'human', data: { content: 'hi' } } as StoredMessage;

describe('history item-mapper', () => {
  it('builds a message item with PK/SK and round-trips the message', async () => {
    const item = await buildMessageItem(context(), 's1', '01HZX', stored);
    expect(item.PK).toBe('HIST#s1');
    expect(item.SK).toBe('HISTORY#MSG#01HZX');
    expect(item.sessionId).toBe('s1');
    expect(item.ttl).toBeUndefined();
    expect(await decodePayload(item.message, { serde: JSON_SERDE }, [])).toEqual(stored);
  });

  it('stamps a ttl when provided', async () => {
    const item = await buildMessageItem(context(), 's1', '01HZX', stored, 1750);
    expect(item.ttl).toBe(1750);
  });

  /**
   * The message's own ULID is already unique to the write, so it is the object
   * id, below the session: `<keyPrefix><sessionId, base64url>/<ulid>.bin`.
   */
  it("offloads a message under its session, in an object named by the message's own ULID", async () => {
    const upload = jest.fn(async (key: string) => key);
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => buildS3Key('p/', parts, objectId),
      upload,
    };
    const ulid = '01J9ZQ5X3N8VQ4M6C2T7R0K1HD';
    const item = await buildMessageItem(
      { ...context(), offloader: offloader as never },
      's1',
      ulid,
      stored,
    );
    const key = `p/${Buffer.from('s1', 'utf8').toString('base64url')}/${ulid}.bin`;
    expect(item.message).toMatchObject({ location: PayloadLocation.S3, s3Key: key });
    expect(upload).toHaveBeenCalledWith(
      key,
      expect.any(Uint8Array),
      { pk: 'HIST#s1', sk: `HISTORY#MSG#${ulid}` },
      undefined,
    );
  });
});

/**
 * The message key space is this adapter's; a row found in it is not
 * necessarily. The narrow is what stands between a hand-written or foreign row
 * and a decode that trusts the key it was found at.
 */
describe('narrowMessageItem', () => {
  const message = { location: PayloadLocation.INLINE, serdeType: 'json', compressed: false };
  const row = (extra: Record<string, unknown>) => ({
    PK: 'HIST#s1',
    SK: 'HISTORY#MSG#01A',
    ...extra,
  });

  it('accepts a row this package wrote', async () => {
    const item = await buildMessageItem(context(), 's1', '01HZX', stored);
    expect(narrowMessageItem(item)).toBe(item);
  });

  it.each([
    ['no sessionId', row({ message })],
    ['a sessionId that is not a string', row({ sessionId: 1, message })],
    ['no message attribute', row({ sessionId: 's1' })],
    ['a message attribute of null', row({ sessionId: 's1', message: null })],
    ['a message attribute that is not an object', row({ sessionId: 's1', message: 'x' })],
    ['a sessionId disagreeing with its partition', row({ sessionId: 'other', message })],
  ])('refuses a row with %s', (_name, raw) => {
    expect(narrowMessageItem(raw)).toBeUndefined();
  });
});
