import { numberOf, statedCounts } from './guards/stated-counts';

/**
 * A count in prose is a fact about the repository that nothing re-derives: the
 * record, claim or job added after the sentence was written leaves its number
 * behind, and a reader who counts finds the documentation wrong about itself.
 */
describe('every count the documentation states about the repository', () => {
  it('finds the sentence carrying each count, so a reworded one cannot pass silently', () => {
    expect(
      statedCounts()
        .filter((count) => count.stated === undefined)
        .map((count) => count.claim),
    ).toEqual([]);
  });

  it.each(statedCounts().map((count) => [count.claim, count] as const))(
    '%s matches what is there',
    (_claim, count) => {
      expect(count.stated).toBe(count.actual);
    },
  );
});

describe('guard internals', () => {
  it('reads digits and number words below one hundred, in either case', () => {
    expect(numberOf('29')).toBe(29);
    expect(numberOf('nine')).toBe(9);
    expect(numberOf('Seventeen')).toBe(17);
    expect(numberOf('Twenty')).toBe(20);
    expect(numberOf('Twenty-nine')).toBe(29);
    expect(numberOf('ninety-one')).toBe(91);
  });

  it('reads nothing into a word that is not a number', () => {
    expect(numberOf('several')).toBeUndefined();
    expect(numberOf('nine-one')).toBeUndefined();
    expect(numberOf('twenty-ten')).toBeUndefined();
    expect(numberOf('twenty-zero')).toBeUndefined();
  });
});
