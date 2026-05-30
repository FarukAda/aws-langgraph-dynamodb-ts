import { findDeadErrorCodes, listErrorCodeMembers } from './guards/error-codes';

describe('ErrorCode enum', () => {
  it('declares at least one member', () => {
    expect(listErrorCodeMembers().length).toBeGreaterThan(0);
  });

  it('has no dead member (every code is thrown or referenced in src)', () => {
    expect(findDeadErrorCodes()).toEqual([]);
  });
});
