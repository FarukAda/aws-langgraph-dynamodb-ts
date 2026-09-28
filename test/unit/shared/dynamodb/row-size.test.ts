import { MAX_ROW_BYTES, rowSizeBytes } from '../../../../src/shared/dynamodb/row-size';

describe('rowSizeBytes', () => {
  it('counts a string by its UTF-8 bytes, beside its name', () => {
    expect(rowSizeBytes({ a: 'xyz' })).toBe(4);
    expect(rowSizeBytes({ a: 'é' })).toBe(3);
  });

  it('counts a number by its significant digits, halved and rounded up, plus one', () => {
    expect(rowSizeBytes({ n: 12345 })).toBe(1 + 4);
    expect(rowSizeBytes({ n: 0.5 })).toBe(1 + 2);
    expect(rowSizeBytes({ n: 1000 })).toBe(1 + 2);
    expect(rowSizeBytes({ n: -1.25e-7 })).toBe(1 + 3);
  });

  it('counts binary by its raw bytes, and a boolean or a null as one', () => {
    expect(rowSizeBytes({ b: new Uint8Array(10) })).toBe(11);
    expect(rowSizeBytes({ t: true, z: null })).toBe(4);
  });

  it('adds three bytes per list or map and one per element', () => {
    expect(rowSizeBytes({ l: [1, 2] })).toBe(1 + 3 + (2 + 1) * 2);
    expect(rowSizeBytes({ m: { k: 'v' } })).toBe(1 + 3 + (1 + 1 + 1));
  });

  it('is the 400 KB DynamoDB caps an item at', () => {
    expect(MAX_ROW_BYTES).toBe(409_600);
  });
});
