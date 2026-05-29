import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { matchesStoreFilter } from '../../../../src/store/internal/filter';

describe('matchesStoreFilter', () => {
  const value = { status: 'active', score: 4.5, tags: ['a', 'b'], nested: { x: 1 } };

  it('matches direct equality (implicit $eq), including arrays/objects', () => {
    expect(matchesStoreFilter(value, { status: 'active' })).toBe(true);
    expect(matchesStoreFilter(value, { status: 'inactive' })).toBe(false);
    expect(matchesStoreFilter(value, { tags: ['a', 'b'] })).toBe(true);
    expect(matchesStoreFilter(value, { nested: { x: 1 } })).toBe(true);
  });

  it('supports comparison operators', () => {
    expect(matchesStoreFilter(value, { score: { $gt: 4 } })).toBe(true);
    expect(matchesStoreFilter(value, { score: { $gte: 4.5 } })).toBe(true);
    expect(matchesStoreFilter(value, { score: { $lt: 4 } })).toBe(false);
    expect(matchesStoreFilter(value, { score: { $lte: 4.5 } })).toBe(true);
    expect(matchesStoreFilter(value, { status: { $ne: 'archived' } })).toBe(true);
    expect(matchesStoreFilter(value, { status: { $eq: 'active' } })).toBe(true);
  });

  it('requires every condition to hold (AND semantics)', () => {
    expect(matchesStoreFilter(value, { status: 'active', score: { $gte: 5 } })).toBe(false);
    expect(matchesStoreFilter(value, { status: 'active', score: { $gte: 4 } })).toBe(true);
  });

  it('matches the empty filter', () => {
    expect(matchesStoreFilter(value, {})).toBe(true);
  });

  it('throws VALIDATION on an unknown operator', () => {
    try {
      matchesStoreFilter(value, { score: { $bogus: 1 } });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });
});
