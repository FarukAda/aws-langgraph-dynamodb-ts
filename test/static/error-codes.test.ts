import {
  enumMembersOf,
  findDeadErrorCodes,
  listErrorCodeMembers,
  referencesErrorCode,
} from './guards/error-codes';

describe('ErrorCode enum', () => {
  it('declares at least one member', () => {
    expect(listErrorCodeMembers().length).toBeGreaterThan(0);
  });

  it('has no dead member (every code is thrown or referenced in src)', () => {
    expect(findDeadErrorCodes()).toEqual([]);
  });
});

describe('guard internals (TEST-12)', () => {
  it('lists enum members from the AST, ignoring other declarations in the file', () => {
    expect(
      enumMembersOf(
        "export enum ErrorCode {\n  A = 'A',\n  B = 'B',\n}\nconst FOO = 1;\nexport enum Other { C = 'C' }",
      ),
    ).toEqual(['A', 'B']);
  });

  it('matches a reference only as a whole token', () => {
    expect(referencesErrorCode('VALIDATION', 'throw x(ErrorCode.VALIDATION_FAILED)')).toBe(false);
    expect(referencesErrorCode('VALIDATION', 'throw x(ErrorCode.VALIDATION)')).toBe(true);
    expect(referencesErrorCode('VALIDATION', 'MyErrorCode.VALIDATION')).toBe(false);
  });
});
