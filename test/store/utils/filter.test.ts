import { buildFilterExpression } from '../../../src/store/utils';

describe('filter utility', () => {
  describe('buildFilterExpression', () => {
    it('should build expression for simple equality', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { status: 'active' },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 = :val0');
      expect(expressionAttributeNames).toEqual({
        '#value': 'value',
        '#attr0': 'status',
      });
      expect(expressionAttributeValues).toEqual({
        ':val0': 'active',
      });
    });

    it('should build expression for $eq operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { age: { $eq: 25 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 = :val0');
      expect(expressionAttributeNames['#attr0']).toBe('age');
      expect(expressionAttributeValues[':val0']).toBe(25);
    });

    it('should build expression for $ne operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { status: { $ne: 'deleted' } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 <> :val0');
      expect(expressionAttributeValues[':val0']).toBe('deleted');
    });

    it('should build expression for $gt operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { score: { $gt: 100 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 > :val0');
      expect(expressionAttributeValues[':val0']).toBe(100);
    });

    it('should build expression for $gte operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { age: { $gte: 18 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 >= :val0');
      expect(expressionAttributeValues[':val0']).toBe(18);
    });

    it('should build expression for $lt operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { price: { $lt: 50 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 < :val0');
      expect(expressionAttributeValues[':val0']).toBe(50);
    });

    it('should build expression for $lte operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { count: { $lte: 10 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 <= :val0');
      expect(expressionAttributeValues[':val0']).toBe(10);
    });

    it('should build expression for multiple conditions', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        {
          status: 'active',
          age: { $gte: 18 },
        },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toContain(' AND ');
      expect(result.filterExpression).toContain('#value.#attr0');
      expect(result.filterExpression).toContain('#value.#attr1');
      expect(Object.keys(expressionAttributeNames)).toHaveLength(3); // #value + 2 attrs
      expect(Object.keys(expressionAttributeValues)).toHaveLength(2);
    });

    it('should build expression for multiple operators on same field', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { age: { $gte: 18, $lte: 65 } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toContain(' AND ');
      expect(result.filterExpression).toContain('>=');
      expect(result.filterExpression).toContain('<=');
      expect(expressionAttributeValues[':val0']).toBe(18);
      expect(expressionAttributeValues[':val1']).toBe(65);
    });

    it('should return empty expression for empty filter', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression({}, expressionAttributeNames, expressionAttributeValues);

      expect(result.filterExpression).toBe('');
    });

    it('should increment counters for existing attributes', () => {
      const expressionAttributeNames: Record<string, string> = {
        '#existing': 'existing_field',
      };
      const expressionAttributeValues: Record<string, any> = {
        ':existingVal': 'existing_value',
      };

      const result = buildFilterExpression(
        { newField: 'newValue' },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr1 = :val1');
      expect(expressionAttributeNames).toEqual({
        '#existing': 'existing_field',
        '#value': 'value',
        '#attr1': 'newField',
      });
      expect(expressionAttributeValues).toEqual({
        ':existingVal': 'existing_value',
        ':val1': 'newValue',
      });
    });

    it('should handle null values', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { field: null },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 = :val0');
      expect(expressionAttributeValues[':val0']).toBeNull();
    });

    it('should handle array values', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { tags: [1, 2, 3] },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 = :val0');
      expect(expressionAttributeValues[':val0']).toEqual([1, 2, 3]);
    });

    it('should not add #value if already present', () => {
      const expressionAttributeNames: Record<string, string> = {
        '#value': 'value',
      };
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { field: 'test' },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr1 = :val0');
      expect(Object.keys(expressionAttributeNames)).toHaveLength(2); // #value + #attr1
    });

    it('should handle complex nested filter values', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        {
          name: 'John',
          age: { $gte: 18, $lt: 65 },
          status: { $ne: 'deleted' },
        },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression.split(' AND ')).toHaveLength(4);
      expect(expressionAttributeValues[':val0']).toBe('John');
    });

    it('should build expression for $in operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { status: { $in: ['active', 'pending'] } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('#value.#attr0 IN (:val0, :val1)');
      expect(expressionAttributeValues).toEqual({
        ':val0': 'active',
        ':val1': 'pending',
      });
    });

    it('should build expression for $nin operator', () => {
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      const result = buildFilterExpression(
        { status: { $nin: ['deleted', 'archived'] } },
        expressionAttributeNames,
        expressionAttributeValues,
      );

      expect(result.filterExpression).toBe('NOT (#value.#attr0 IN (:val0, :val1))');
      expect(expressionAttributeValues).toEqual({
        ':val0': 'deleted',
        ':val1': 'archived',
      });
    });

    it('should reject $in with non-array value', () => {
      expect(() =>
        buildFilterExpression({ status: { $in: 'active' as unknown as any[] } }, {}, {}),
      ).toThrow('$in operator for "status" requires a non-empty array');
    });

    it('should reject empty $in array', () => {
      expect(() => buildFilterExpression({ status: { $in: [] } }, {}, {})).toThrow(
        '$in operator for "status" requires a non-empty array',
      );
    });

    it('should reject $in arrays exceeding the 50-value cap', () => {
      const oversized = Array.from({ length: 51 }, (_, i) => `v${i}`);
      expect(() => buildFilterExpression({ status: { $in: oversized } }, {}, {})).toThrow(
        /\$in operator for "status" supports at most 50 values/,
      );
    });

    it('should reject $nin arrays exceeding the 50-value cap', () => {
      const oversized = Array.from({ length: 51 }, (_, i) => `v${i}`);
      expect(() => buildFilterExpression({ status: { $nin: oversized } }, {}, {})).toThrow(
        /\$nin operator for "status" supports at most 50 values/,
      );
    });

    it('should accept $in arrays at exactly the 50-value cap', () => {
      const atCap = Array.from({ length: 50 }, (_, i) => `v${i}`);
      expect(() => buildFilterExpression({ status: { $in: atCap } }, {}, {})).not.toThrow();
    });

    it('should reject filter expressions that would exceed the 4 KiB DynamoDB cap', () => {
      // Build enough distinct fields to push the assembled expression past 3.5 KiB.
      // Each "#attrN.#value = :valN" clause is ~20 bytes once joined with " AND ".
      const filter: Record<string, unknown> = {};
      for (let i = 0; i < 300; i++) {
        filter[`very_long_field_name_number_${i}`] = `v${i}`;
      }
      expect(() => buildFilterExpression(filter, {}, {})).toThrow(/Filter expression is .* bytes/);
    });

    it('should reject unknown operators to surface typos', () => {
      expect(() =>
        buildFilterExpression({ field: { $contains: 'x' } as unknown as any }, {}, {}),
      ).toThrow(/Unsupported filter operator.*\$contains/);
    });
  });
});
