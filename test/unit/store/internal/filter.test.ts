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

  it('supports $in and $nin', () => {
    expect(matchesStoreFilter(value, { status: { $in: ['active', 'archived'] } })).toBe(true);
    expect(matchesStoreFilter(value, { status: { $in: ['archived'] } })).toBe(false);
    expect(matchesStoreFilter(value, { status: { $nin: ['archived'] } })).toBe(true);
    expect(matchesStoreFilter(value, { status: { $nin: ['active'] } })).toBe(false);
  });

  it('matches $in/$nin against an object/array member by deep equality, like $eq', () => {
    const objectValue = { tags: { kind: 'x' } };
    expect(matchesStoreFilter(objectValue, { tags: { $eq: { kind: 'x' } } })).toBe(true);
    expect(matchesStoreFilter(objectValue, { tags: { $in: [{ kind: 'x' }] } })).toBe(true);
    expect(matchesStoreFilter(objectValue, { tags: { $in: [{ kind: 'y' }] } })).toBe(false);
    expect(matchesStoreFilter(objectValue, { tags: { $nin: [{ kind: 'x' }] } })).toBe(false);
    expect(matchesStoreFilter(objectValue, { tags: { $nin: [{ kind: 'y' }] } })).toBe(true);

    const arrayValue = { list: [1, 2] };
    expect(matchesStoreFilter(arrayValue, { list: { $in: [[1, 2]] } })).toBe(true);
  });

  it('treats $in/$nin against a non-array expected value as their documented fallback', () => {
    expect(matchesStoreFilter(value, { status: { $in: 'not-an-array' as never } })).toBe(false);
    expect(matchesStoreFilter(value, { status: { $nin: 'not-an-array' as never } })).toBe(true);
  });

  it('treats an unrecognized $-prefixed condition as a literal value to match, not an operator (parity with the official InMemoryStore)', () => {
    expect(matchesStoreFilter(value, { score: { $bogus: 1 } })).toBe(false);
  });

  it('does not misdetect a data value whose keys collide with Object.prototype members as a filter operator', () => {
    expect(
      matchesStoreFilter({ meta: { totallyDifferent: true } }, { meta: { constructor: 'Foo' } }),
    ).toBe(false);
    expect(
      matchesStoreFilter({ meta: { constructor: 'Foo' } }, { meta: { constructor: 'Foo' } }),
    ).toBe(true);
  });

  it('does not misdetect a stored value with $-prefixed keys (e.g. a JSON Schema document) as a filter operator', () => {
    const schemaValue = { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' } };
    expect(
      matchesStoreFilter(schemaValue, {
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
      }),
    ).toBe(true);
    expect(matchesStoreFilter(schemaValue, { schema: { $schema: 'other' } })).toBe(false);
  });

  it('does not vacuously match every item when a field condition is an empty operator object', () => {
    const testValue = { status: 'active' };
    expect(matchesStoreFilter(testValue, { role: {} })).toBe(false);
    expect(matchesStoreFilter({ role: 'admin' }, { role: {} })).toBe(false);
    // A structurally-equal empty object as the field's actual value still
    // exact-matches, since {} then falls through to the plain-value branch:
    expect(matchesStoreFilter({ role: {} }, { role: {} })).toBe(true);
  });
});
