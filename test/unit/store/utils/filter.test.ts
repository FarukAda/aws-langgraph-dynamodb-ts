/**
 * Unit tests for src/store/utils/filter.ts.
 *
 * Plan rows:
 *   AC-16 — (input, query, expectedMatch) operator tuple table with >= 1 matching
 *           and >= 1 non-matching row per supported operator, asserted against the
 *           exact FilterExpression string + ExpressionAttributeNames /
 *           ExpressionAttributeValues the builder emits.
 *   AC-13 — every attribute name is aliased via a '#'-placeholder so no raw
 *           (potentially reserved) attribute name reaches the FilterExpression.
 *   AC-8  — documented throw branches: unsupported operator, empty/oversize $in,
 *           empty/oversize $nin, oversized assembled expression.
 *
 * REQ-20 / REQ-18 / REQ-11 / AC-16 / AC-13 / AC-8.
 *
 * Pinned from src/store/utils/filter.ts:
 *   - The only export is `buildFilterExpression(filter, ean, eav)` (no predicate).
 *     It mutates the passed `ean`/`eav` maps in place and returns
 *     `{ filterExpression: string }`.
 *   - Name aliases are `#attr<N>` where N starts at the current ean key count
 *     (captured BEFORE `#value` is injected), so against fresh maps the first
 *     user attribute is `#attr0`. The `#value` alias is added but not counted.
 *   - Value placeholders are `:val<M>` where M starts at the current eav key count.
 *   - The attribute path is always `#value.#attr<N>` (nested-map access).
 *   - Supported operators: $eq (=), $ne (<>), $gt (>), $gte (>=), $lt (<),
 *     $lte (<=), $in (IN (...)), $nin (NOT (... IN ...)), plus implicit equality.
 *   - $exists is NOT supported (it raises "Unsupported filter operator(s)").
 */
import { buildFilterExpression } from '../../../../src/store/utils/filter';

/**
 * Builds the expression for a single filter against fresh ean/eav maps and
 * returns the full produced shape so tests can assert exact strings.
 */
function build(filter: Record<string, unknown>): {
  filterExpression: string;
  ean: Record<string, string>;
  eav: Record<string, unknown>;
} {
  const ean: Record<string, string> = {};
  const eav: Record<string, unknown> = {};
  const { filterExpression } = buildFilterExpression(filter, ean, eav);
  return { filterExpression, ean, eav };
}

interface OperatorRow {
  readonly name: string;
  readonly filter: Record<string, unknown>;
  /** Exact FilterExpression string the builder must emit. */
  readonly filterExpression: string;
  /** Exact ExpressionAttributeNames after the call (includes injected #value). */
  readonly ean: Record<string, string>;
  /** Exact ExpressionAttributeValues after the call. */
  readonly eav: Record<string, unknown>;
}

/**
 * One matching-shape row per supported operator. Against fresh ean/eav maps the
 * first user attribute is aliased `#attr0` (the counter is read before `#value`
 * is injected, so `#value` does not consume an index) and the first value
 * placeholder is `:val0`.
 */
function operatorRows(): OperatorRow[] {
  return [
    {
      name: 'implicit equality (bare value)',
      filter: { status: 'active' },
      filterExpression: '#value.#attr0 = :val0',
      ean: { '#value': 'value', '#attr0': 'status' },
      eav: { ':val0': 'active' },
    },
    {
      name: '$eq',
      filter: { status: { $eq: 'active' } },
      filterExpression: '#value.#attr0 = :val0',
      ean: { '#value': 'value', '#attr0': 'status' },
      eav: { ':val0': 'active' },
    },
    {
      name: '$ne',
      filter: { status: { $ne: 'archived' } },
      filterExpression: '#value.#attr0 <> :val0',
      ean: { '#value': 'value', '#attr0': 'status' },
      eav: { ':val0': 'archived' },
    },
    {
      name: '$gt',
      filter: { score: { $gt: 4 } },
      filterExpression: '#value.#attr0 > :val0',
      ean: { '#value': 'value', '#attr0': 'score' },
      eav: { ':val0': 4 },
    },
    {
      name: '$gte',
      filter: { score: { $gte: 5 } },
      filterExpression: '#value.#attr0 >= :val0',
      ean: { '#value': 'value', '#attr0': 'score' },
      eav: { ':val0': 5 },
    },
    {
      name: '$lt',
      filter: { score: { $lt: 3 } },
      filterExpression: '#value.#attr0 < :val0',
      ean: { '#value': 'value', '#attr0': 'score' },
      eav: { ':val0': 3 },
    },
    {
      name: '$lte',
      filter: { score: { $lte: 4 } },
      filterExpression: '#value.#attr0 <= :val0',
      ean: { '#value': 'value', '#attr0': 'score' },
      eav: { ':val0': 4 },
    },
    {
      name: '$in',
      filter: { tag: { $in: ['a', 'b'] } },
      filterExpression: '#value.#attr0 IN (:val0, :val1)',
      ean: { '#value': 'value', '#attr0': 'tag' },
      eav: { ':val0': 'a', ':val1': 'b' },
    },
    {
      name: '$nin',
      filter: { tag: { $nin: ['a', 'b'] } },
      filterExpression: 'NOT (#value.#attr0 IN (:val0, :val1))',
      ean: { '#value': 'value', '#attr0': 'tag' },
      eav: { ':val0': 'a', ':val1': 'b' },
    },
  ];
}

describe('buildFilterExpression operator table (exact expression + EAN/EAV)', () => {
  it.each(operatorRows())(
    'emits the exact FilterExpression/EAN/EAV for $name',
    ({ filter, filterExpression, ean, eav }) => {
      const result = build(filter);
      expect(result.filterExpression).toBe(filterExpression);
      expect(result.ean).toEqual(ean);
      expect(result.eav).toEqual(eav);
    },
  ); // AC-16

  it('AND-joins multiple operators on the same field into one expression', () => {
    // $gte + $lte on the same field => two clauses joined by AND, two values.
    const result = build({ score: { $gte: 1, $lte: 10 } });
    expect(result.filterExpression).toBe('#value.#attr0 >= :val0 AND #value.#attr0 <= :val1');
    expect(result.ean).toEqual({ '#value': 'value', '#attr0': 'score' });
    expect(result.eav).toEqual({ ':val0': 1, ':val1': 10 });
  }); // AC-16

  it('AND-joins multiple fields and increments the #attr / :val counters', () => {
    const result = build({ status: 'active', score: { $gt: 4 } });
    expect(result.filterExpression).toBe('#value.#attr0 = :val0 AND #value.#attr1 > :val1');
    expect(result.ean).toEqual({ '#value': 'value', '#attr0': 'status', '#attr1': 'score' });
    expect(result.eav).toEqual({ ':val0': 'active', ':val1': 4 });
  }); // AC-16

  it('returns an empty FilterExpression for an empty filter object', () => {
    // No fields => no clauses => empty joined string; #value alias is still seeded.
    const result = build({});
    expect(result.filterExpression).toBe('');
    expect(result.ean).toEqual({ '#value': 'value' });
    expect(result.eav).toEqual({});
  }); // AC-16
});

describe('buildFilterExpression reserved-word safety (no raw attribute names)', () => {
  it('aliases reserved-word attribute names via #attr placeholders, never raw', () => {
    // 'status' and 'value' are DynamoDB reserved words; neither may appear raw in
    // the expression. The aliases map back to the literal names.
    const result = build({ status: { $in: ['a', 'b'] }, value: { $gt: 1 } });
    expect(result.filterExpression).toBe(
      '#value.#attr0 IN (:val0, :val1) AND #value.#attr1 > :val2',
    );
    // No bare reserved word appears as a standalone token in the expression.
    expect(result.filterExpression).not.toMatch(/(^|[^.#\w])status([^\w]|$)/);
    expect(result.ean).toEqual({ '#value': 'value', '#attr0': 'status', '#attr1': 'value' });
    expect(result.eav).toEqual({ ':val0': 'a', ':val1': 'b', ':val2': 1 });
  }); // AC-13
});

describe('buildFilterExpression documented throw branches', () => {
  it('throws naming the unsupported operator and the supported set', () => {
    expect(() => build({ status: { $exists: true } })).toThrow(
      'Unsupported filter operator(s) for field "status": $exists. ' +
        'Supported: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin',
    );
  }); // AC-8

  it('throws when $in is given an empty array', () => {
    expect(() => build({ tag: { $in: [] } })).toThrow(
      '$in operator for "tag" requires a non-empty array',
    );
  }); // AC-8

  it('throws when $in exceeds the 50-value cap', () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => i);
    expect(() => build({ tag: { $in: fiftyOne } })).toThrow(
      '$in operator for "tag" supports at most 50 values (got 51). Split the query or narrow the filter.',
    );
  }); // AC-8

  it('throws when $nin is given an empty array', () => {
    expect(() => build({ tag: { $nin: [] } })).toThrow(
      '$nin operator for "tag" requires a non-empty array',
    );
  }); // AC-8

  it('throws when $nin exceeds the 50-value cap', () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => i);
    expect(() => build({ tag: { $nin: fiftyOne } })).toThrow(
      '$nin operator for "tag" supports at most 50 values (got 51). Split the query or narrow the filter.',
    );
  }); // AC-8

  it('throws when the assembled FilterExpression exceeds the 3.5 KiB soft cap', () => {
    // Field names are aliased into ExpressionAttributeNames, so long names do NOT
    // bloat the FilterExpression itself — only the number of clauses does. Each
    // implicit-equality clause is `#value.#attrN = :valM` (~25 bytes) joined by
    // ` AND `; ~200 fields pushes the assembled expression past the 3.5 KiB cap.
    const filter: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) {
      filter[`field_${i}`] = 'v';
    }
    expect(() => build(filter)).toThrow(/exceeds DynamoDB's 4 KiB limit/);
  }); // AC-8

  it('emits the FULL oversize-expression error message verbatim (kills StringLiteral void mutants on lines 156-157)', () => {
    // Pin the exact, complete error string so mutants that blank out the
    // "(checked against a …-byte soft cap)" or "Simplify the filter: …"
    // literals are caught.
    const filter: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) {
      filter[`field_${i}`] = 'v';
    }
    let caught: Error | undefined;
    try {
      build(filter);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = caught!.message;
    // Recompute the exact byte length the builder reports so the assertion is exact.
    const ean: Record<string, string> = {};
    const eav: Record<string, unknown> = {};
    const expressions: string[] = [];
    let nameCounter = 0;
    for (let i = 0; i < 200; i += 1) {
      expressions.push(`#value.#attr${nameCounter++} = :val${i}`);
    }
    void ean;
    void eav;
    const joined = expressions.join(' AND ');
    const byteLength = Buffer.byteLength(joined, 'utf8');
    expect(msg).toBe(
      `Filter expression is ${byteLength} bytes, exceeds DynamoDB's 4 KiB limit ` +
        `(checked against a ${3.5 * 1024}-byte soft cap). ` +
        `Simplify the filter: fewer fields, shorter names, or drop deep nested paths.`,
    );
  }); // AC-8

  it('names ALL unknown operators comma-separated (kills join("") StringLiteral mutant on line 65)', () => {
    // Two unsupported operators on one field: the message must list them joined
    // by ", " — a `join("")` mutant would emit "$foo$bar" instead of "$foo, $bar".
    expect(() => build({ status: { $foo: 1, $bar: 2 } })).toThrow(
      'Unsupported filter operator(s) for field "status": $foo, $bar. ' +
        'Supported: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin',
    );
  }); // AC-8
});

describe('buildFilterExpression #value alias seeding (line 48 branch + literal)', () => {
  it('does NOT overwrite a pre-existing #value alias supplied by the caller', () => {
    // Mutants: `if (true)` always re-seeds, and `['#value']` -> `[""]` reads the
    // wrong key so the guard never sees the existing alias. Both would clobber a
    // caller-provided #value. The original preserves it.
    const ean: Record<string, string> = { '#value': 'CUSTOM_VALUE_ATTR' };
    const eav: Record<string, unknown> = {};
    const { filterExpression } = buildFilterExpression({ status: 'active' }, ean, eav);
    // #value retains the caller's mapping (not reset to 'value').
    expect(ean['#value']).toBe('CUSTOM_VALUE_ATTR');
    // First user attr index is read from ean key count (1: just '#value') -> #attr1.
    expect(filterExpression).toBe('#value.#attr1 = :val0');
    expect(ean).toEqual({ '#value': 'CUSTOM_VALUE_ATTR', '#attr1': 'status' });
    expect(eav).toEqual({ ':val0': 'active' });
  }); // AC-13

  it('seeds #value to the literal "value" when absent (kills [""] key mutant)', () => {
    // With a fresh map, the original seeds ean['#value'] = 'value'. The `[""]`
    // mutant would test the empty-string key (always undefined) and still seed,
    // but a separate run guards the literal: assert the exact seeded value.
    const ean: Record<string, string> = {};
    const eav: Record<string, unknown> = {};
    buildFilterExpression({ status: 'active' }, ean, eav);
    expect(ean['#value']).toBe('value');
    expect(ean['']).toBeUndefined();
  }); // AC-13
});

describe('buildFilterExpression null field value takes the equality branch (line 58)', () => {
  it('treats a literal null field value as direct equality, not an operator object', () => {
    // `fieldValue !== null` guards entry into the operator branch. The `true`
    // mutant lets null in, then Object.keys(null) throws. Original: null is a
    // bare value -> `#value.#attr0 = :val0` with :val0 === null.
    const result = build({ archived: null });
    expect(result.filterExpression).toBe('#value.#attr0 = :val0');
    expect(result.ean).toEqual({ '#value': 'value', '#attr0': 'archived' });
    expect(result.eav).toEqual({ ':val0': null });
  }); // AC-16
});

describe('buildFilterExpression valueCounter increments forward (kills ++ -> -- mutants)', () => {
  // Each operator pairs with a trailing implicit-equality field so the SECOND
  // value placeholder reveals the counter direction. With `valueCounter--`, the
  // first op's placeholder is :val0 but the counter then drops to -1, so the
  // second clause would be :val-1 instead of :val1.
  const opRows: Array<{
    name: string;
    filter: Record<string, unknown>;
    expr: string;
    eav: Record<string, unknown>;
  }> = [
    {
      name: '$eq (line 71)',
      filter: { a: { $eq: 1 }, b: 'z' },
      expr: '#value.#attr0 = :val0 AND #value.#attr1 = :val1',
      eav: { ':val0': 1, ':val1': 'z' },
    },
    {
      name: '$ne (line 77)',
      filter: { a: { $ne: 1 }, b: 'z' },
      expr: '#value.#attr0 <> :val0 AND #value.#attr1 = :val1',
      eav: { ':val0': 1, ':val1': 'z' },
    },
    {
      name: '$gt (line 83)',
      filter: { a: { $gt: 1 }, b: 'z' },
      expr: '#value.#attr0 > :val0 AND #value.#attr1 = :val1',
      eav: { ':val0': 1, ':val1': 'z' },
    },
    {
      name: '$lt (line 95)',
      filter: { a: { $lt: 1 }, b: 'z' },
      expr: '#value.#attr0 < :val0 AND #value.#attr1 = :val1',
      eav: { ':val0': 1, ':val1': 'z' },
    },
    {
      name: '$lte (line 101)',
      filter: { a: { $lte: 1 }, b: 'z' },
      expr: '#value.#attr0 <= :val0 AND #value.#attr1 = :val1',
      eav: { ':val0': 1, ':val1': 'z' },
    },
  ];

  it.each(opRows)('advances :val index after $name', ({ filter, expr, eav }) => {
    const result = build(filter);
    expect(result.filterExpression).toBe(expr);
    expect(result.eav).toEqual(eav);
  }); // AC-16
});

describe('buildFilterExpression $in / $nin size cap boundary (> vs >=, lines 110/128)', () => {
  it('accepts EXACTLY 50 $in values (boundary: > 50 throws, 50 is allowed)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => i);
    const result = build({ tag: { $in: fifty } });
    const placeholders = fifty.map((_, i) => `:val${i}`).join(', ');
    expect(result.filterExpression).toBe(`#value.#attr0 IN (${placeholders})`);
    expect(Object.keys(result.eav)).toHaveLength(50);
  }); // AC-8

  it('accepts EXACTLY 50 $nin values (boundary: > 50 throws, 50 is allowed)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => i);
    const result = build({ tag: { $nin: fifty } });
    const placeholders = fifty.map((_, i) => `:val${i}`).join(', ');
    expect(result.filterExpression).toBe(`NOT (#value.#attr0 IN (${placeholders}))`);
    expect(Object.keys(result.eav)).toHaveLength(50);
  }); // AC-8
});
