import {
  DEFAULT_INDEX_SHARDS,
  indexKeys,
  indexPartitions,
} from '../../../../src/shared/dynamodb/recency-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

describe('indexKeys', () => {
  /**
   * A row's index entry must be findable and deletable without a scan, so the
   * same id has to land on the same shard across processes, releases and
   * machines.
   */
  it('maps one id to one shard, every time', () => {
    const first = indexKeys('STORE', 'items#k1', '2026-01-01T00:00:00.000Z', 8);
    const again = indexKeys('STORE', 'items#k1', '2026-06-01T00:00:00.000Z', 8);
    expect(first.gsi1pk).toBe(again.gsi1pk);
  });

  it('spreads ids across the configured shards rather than concentrating them', () => {
    const used = new Set(
      Array.from({ length: 200 }, (_unused, i) =>
        indexKeys('SESS', `session-${i}`, 'x', DEFAULT_INDEX_SHARDS),
      ).map((keys) => keys.gsi1pk),
    );
    expect(used.size).toBe(DEFAULT_INDEX_SHARDS);
  });

  it('scopes the index to one adapter', () => {
    expect(indexKeys('CHKPT', 'a', 'x', 4).gsi1pk).toMatch(/^CHKPT#/);
    expect(indexKeys('SESS', 'a', 'x', 4).gsi1pk).toMatch(/^SESS#/);
  });

  /**
   * The timestamp leads and is used unparsed: its byte order already is its
   * chronological order, so a recency listing is a key condition rather than an
   * in-memory sort. The id follows to make the key total, so two rows written
   * in the same millisecond still order and a cursor cannot loop.
   */
  it('sorts by time, then by id', () => {
    const earlier = indexKeys('SESS', 'b', '2026-01-01T00:00:00.000Z', 4).gsi1sk;
    const later = indexKeys('SESS', 'a', '2026-01-02T00:00:00.000Z', 4).gsi1sk;
    expect(earlier < later).toBe(true);
    const tieA = indexKeys('SESS', 'a', '2026-01-01T00:00:00.000Z', 4).gsi1sk;
    const tieB = indexKeys('SESS', 'b', '2026-01-01T00:00:00.000Z', 4).gsi1sk;
    expect(tieA < tieB).toBe(true);
  });

  it('accepts a single shard, which means no fan-out', () => {
    expect(indexKeys('STORE', 'a', 'x', 1).gsi1pk).toBe('STORE#0');
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses %p shards instead of producing a broken key',
    (bad) => {
      try {
        indexKeys('STORE', 'a', 'x', bad);
        throw new Error('expected a throw');
      } catch (error) {
        expect((error as { code?: string }).code).toBe(ErrorCode.VALIDATION);
        expect((error as { context?: { field?: string } }).context?.field).toBe('indexShards');
      }
    },
  );
});

describe('indexPartitions', () => {
  it('lists every partition a listing must query', () => {
    expect(indexPartitions('SESS', 3)).toEqual(['SESS#0', 'SESS#1', 'SESS#2']);
  });

  it('covers exactly the shards indexKeys can produce', () => {
    const produced = new Set(
      Array.from({ length: 500 }, (_unused, i) => indexKeys('SESS', `s${i}`, 'x', 5).gsi1pk),
    );
    expect([...produced].sort()).toEqual(indexPartitions('SESS', 5).sort());
  });
});

/**
 * The write side refused a bad shard count and the read side did not: an
 * `Array.from({ length: 0 })` is an empty partition list, so a listing would
 * query nothing and report an empty table full of rows.
 */
describe('indexPartitions refuses the counts indexKeys refuses', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects %p', (shards) => {
    expect(() => indexPartitions('CHKPT', shards)).toThrow(/indexShards/);
  });

  it('lists one partition per shard for a valid count', () => {
    expect(indexPartitions('SESS', 3)).toEqual(['SESS#0', 'SESS#1', 'SESS#2']);
  });
});
