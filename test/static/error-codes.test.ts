import {
  enumMembersOf,
  findDeadErrorCodes,
  listErrorCodeMembers,
  referencesErrorCode,
  undocumentedErrorCodes,
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

describe('the README error table', () => {
  it('finds a documented code and reports a missing one', () => {
    expect(undocumentedErrorCodes('| `VALIDATION` | x |')).not.toContain('VALIDATION');
    expect(undocumentedErrorCodes('')).toContain('VALIDATION');
  });

  /** A caller writes a `switch` from that table; a code missing from it is a branch nobody writes. */
  it('lists every ErrorCode member', () => {
    expect(undocumentedErrorCodes()).toEqual([]);
  });
});
