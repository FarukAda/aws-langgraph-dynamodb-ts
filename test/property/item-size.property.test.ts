import fc from 'fast-check';

import { messageSortKey, sessionPartition } from '../../src/history/internal/keys';
import { estimateItemBytes } from '../../src/history/internal/message-chunker';
import type { ChatMessageItem } from '../../src/history/types';
import { PayloadLocation, type PayloadDescriptor } from '../../src/shared/codec/codec';

type Attribute =
  string | number | boolean | Uint8Array | Attribute[] | { [key: string]: Attribute };

const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * DynamoDB's documented item-size rules: UTF-8 bytes for strings, raw bytes for
 * binary, about two digits per byte plus one for numbers, one byte for booleans,
 * three bytes of overhead per map or list plus one per element (and the key
 * name's bytes for map entries), and each top-level attribute's name.
 */
function valueSize(value: Attribute): number {
  if (typeof value === 'string') return utf8(value);
  if (typeof value === 'number') {
    return Math.ceil(String(Math.abs(value)).replace('.', '').length / 2) + 1;
  }
  if (typeof value === 'boolean') return 1;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value))
    return 3 + value.reduce<number>((sum, entry) => sum + 1 + valueSize(entry), 0);
  return (
    3 +
    Object.entries(value).reduce<number>(
      (sum, [key, entry]) => sum + 1 + utf8(key) + valueSize(entry),
      0,
    )
  );
}

function itemSize(item: Record<string, Attribute | undefined>): number {
  return Object.entries(item).reduce(
    (sum, [name, value]) => (value === undefined ? sum : sum + utf8(name) + valueSize(value)),
    0,
  );
}

const text = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 64 });
const descriptor = fc.oneof(
  fc.record({
    location: fc.constant(PayloadLocation.INLINE),
    serdeType: text,
    compressed: fc.boolean(),
    bytes: fc.uint8Array({ maxLength: 4096 }),
  }),
  fc.record({
    location: fc.constant(PayloadLocation.S3),
    serdeType: text,
    compressed: fc.boolean(),
    s3Key: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 200 }),
  }),
) as fc.Arbitrary<PayloadDescriptor>;
const item = fc
  .record({
    sessionId: text,
    ulid: fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    message: descriptor,
    ttl: fc.option(fc.nat(), { nil: undefined }),
  })
  .map(({ sessionId, ulid, message, ttl }): ChatMessageItem => ({
    PK: sessionPartition(sessionId),
    SK: messageSortKey(ulid),
    sessionId,
    message,
    ...(ttl === undefined ? {} : { ttl }),
  }));

describe('estimateItemBytes (property)', () => {
  it('never undershoots the DynamoDB item size, for unicode ids and inline or offloaded payloads', () => {
    fc.assert(
      fc.property(item, (value) => {
        expect(estimateItemBytes(value)).toBeGreaterThanOrEqual(itemSize(value as never));
      }),
      { numRuns: 300 },
    );
  });
});
