import fc from 'fast-check';

import { chunkBySize, estimateItemBytes } from '../../src/history/internal/message-chunker';
import type { ChatMessageItem } from '../../src/history/types';
import { PayloadLocation } from '../../src/shared/codec/codec';

function makeItem(skLen: number, bytesLen: number): ChatMessageItem {
  return {
    PK: 's',
    SK: 'M'.repeat(skLen + 1),
    sessionId: 's',
    message: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(bytesLen),
    },
  };
}

const itemsArb = fc.array(
  fc
    .record({ skLen: fc.nat({ max: 20 }), bytesLen: fc.nat({ max: 2000 }) })
    .map(({ skLen, bytesLen }) => makeItem(skLen, bytesLen)),
  { maxLength: 60 },
);
const maxItemsArb = fc.integer({ min: 1, max: 10 });
const maxBytesArb = fc.integer({ min: 300, max: 6000 });

describe('chunkBySize (property)', () => {
  it('is an order-preserving partition: concatenating the chunks rebuilds the input', () => {
    fc.assert(
      fc.property(itemsArb, maxItemsArb, maxBytesArb, (items, maxItems, maxBytes) => {
        expect(chunkBySize(items, maxItems, maxBytes).flat()).toEqual(items);
      }),
      { numRuns: 300 },
    );
  });

  it('never exceeds the item-count limit per chunk', () => {
    fc.assert(
      fc.property(itemsArb, maxItemsArb, maxBytesArb, (items, maxItems, maxBytes) => {
        for (const chunk of chunkBySize(items, maxItems, maxBytes)) {
          expect(chunk.length).toBeLessThanOrEqual(maxItems);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('only exceeds the byte budget for a single item that alone is oversized', () => {
    fc.assert(
      fc.property(itemsArb, maxItemsArb, maxBytesArb, (items, maxItems, maxBytes) => {
        for (const chunk of chunkBySize(items, maxItems, maxBytes)) {
          const bytes = chunk.reduce((sum, item) => sum + estimateItemBytes(item), 0);
          if (bytes > maxBytes) expect(chunk).toHaveLength(1);
        }
      }),
      { numRuns: 300 },
    );
  });
});
