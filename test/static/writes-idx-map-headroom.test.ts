import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

/**
 * M8: `WRITE_INDEX_OFFSET` (8) is added to every write index before padding so
 * the special negative slots encode as sortable non-negative integers. That
 * constant hardcodes an assumption about the peer dependency's contents, and
 * it cannot be derived at runtime — deriving it would let a dependency bump
 * silently change the on-disk sort-key format. Pin the assumption here
 * instead, so a peer bump that adds a more negative slot fails loudly at test
 * time rather than producing unsortable keys in production.
 */
describe('WRITES_IDX_MAP headroom', () => {
  it('keeps every special slot within WRITE_INDEX_OFFSET of zero', () => {
    const values = Object.values(WRITES_IDX_MAP);
    expect(values.length).toBeGreaterThan(0);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-8);
  });
});
