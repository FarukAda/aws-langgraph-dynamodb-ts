import { nowIso } from '../../../src/shared/clock';
import { FROZEN_NOW_MS } from '../../shared/helpers/test-setup';

describe('nowIso', () => {
  it('returns the frozen clock time as an ISO string', () => {
    expect(nowIso()).toBe(new Date(FROZEN_NOW_MS).toISOString());
  });
});
