import { checkpointIndexTarget } from '../../../src/checkpointer/internal/rows';
import { sessionIndexTarget } from '../../../src/history/internal/session';
import { BACKFILLED_AT, backfilledAt } from '../../../src/shared/dynamodb/recency-index';
import { storeIndexTarget } from '../../../src/store/internal/rows';

describe('which rows the recency index covers, asked of each row owner', () => {
  const meta = { PK: 'CHKPT#t', SK: 'META##c1', checkpointId: 'c1' };
  const item = { PK: 'STORE#users', SK: 'k', updatedAt: '2026-09-01T00:00:00.000Z' };
  const session = { PK: 'HIST#s1', SK: 'HISTORY#SESSION', sessionId: 's1' };

  it('lets each owner name its own rows', () => {
    expect(checkpointIndexTarget(meta)).toEqual({ tag: 'CHKPT', id: 'c1', at: BACKFILLED_AT });
    expect(storeIndexTarget(item)).toEqual({ tag: 'STORE', id: 'k', at: item.updatedAt });
    expect(sessionIndexTarget(session)).toEqual({ tag: 'SESS', id: 's1', at: BACKFILLED_AT });
  });

  it("lets no owner answer for another adapter's row", () => {
    expect(checkpointIndexTarget(item)).toBeUndefined();
    expect(storeIndexTarget(session)).toBeUndefined();
    expect(sessionIndexTarget(meta)).toBeUndefined();
  });

  it('indexes a row at its own time when it recorded one, else before everything', () => {
    expect(backfilledAt('2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
    expect(backfilledAt(undefined)).toBe(BACKFILLED_AT);
  });
});
