import { chunkBySize, estimateItemBytes } from '../../../../src/history/internal/message-chunker';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';

function inlineItem(sk: string, byteLength: number): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(byteLength),
    },
  };
}

function s3Item(sk: string, key: string): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key: key },
  };
}

describe('estimateItemBytes', () => {
  it('counts the inline payload plus key and overhead', () => {
    const small = estimateItemBytes(inlineItem('MSG#1', 0));
    const big = estimateItemBytes(inlineItem('MSG#1', 1000));
    expect(big - small).toBe(1000);
    expect(small).toBeGreaterThan(0);
  });

  it('treats an offloaded item as small (just its key)', () => {
    expect(estimateItemBytes(s3Item('MSG#1', 'k'))).toBeLessThan(
      estimateItemBytes(inlineItem('MSG#1', 100000)),
    );
  });
});

describe('chunkBySize', () => {
  it('keeps a small batch in one chunk', () => {
    const items = [inlineItem('MSG#1', 10), inlineItem('MSG#2', 10)];
    expect(chunkBySize(items, 99, 1_000_000)).toEqual([items]);
  });

  it('splits when the item count hits the max', () => {
    const items = [inlineItem('a', 1), inlineItem('b', 1), inlineItem('c', 1)];
    expect(chunkBySize(items, 2, 1_000_000).map((c) => c.length)).toEqual([2, 1]);
  });

  it('splits when the byte budget would be exceeded', () => {
    const items = [inlineItem('a', 400), inlineItem('b', 400), inlineItem('c', 400)];
    expect(chunkBySize(items, 99, 1400).map((c) => c.length)).toEqual([2, 1]);
  });

  it('puts an oversized lone item in its own chunk rather than dropping it', () => {
    const items = [inlineItem('a', 10), inlineItem('b', 5000)];
    expect(chunkBySize(items, 99, 1000).map((c) => c.length)).toEqual([1, 1]);
  });

  it('returns no chunks for an empty list', () => {
    expect(chunkBySize([], 99, 1000)).toEqual([]);
  });
});
