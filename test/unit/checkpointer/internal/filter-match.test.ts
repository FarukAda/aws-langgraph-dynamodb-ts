import { matchesFilter } from '../../../../src/checkpointer/internal/filter-match';

describe('matchesFilter', () => {
  const metadata = { source: 'loop', step: 3, parents: { '': 'p1' } };

  it('matches when every filter key equals the metadata value', () => {
    expect(matchesFilter(metadata, { source: 'loop' })).toBe(true);
    expect(matchesFilter(metadata, { source: 'loop', step: 3 })).toBe(true);
    expect(matchesFilter(metadata, { parents: { '': 'p1' } })).toBe(true);
  });

  it('fails when any filter key differs or is absent', () => {
    expect(matchesFilter(metadata, { source: 'input' })).toBe(false);
    expect(matchesFilter(metadata, { step: 4 })).toBe(false);
    expect(matchesFilter(metadata, { missing: 'x' })).toBe(false);
  });

  it('matches the empty filter', () => {
    expect(matchesFilter(metadata, {})).toBe(true);
  });
});
