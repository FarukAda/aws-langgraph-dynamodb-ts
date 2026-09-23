import { RETIRED_ERROR_NAMES, retiredNames, retiredNamesIn } from './guards/retired-error-names';

describe('retiredNamesIn', () => {
  it('finds a removed class in code and in prose alike', () => {
    expect(
      retiredNamesIn('throw new ValidationError(x);\n/** Throws: UpstreamError. */', 'a.ts'),
    ).toEqual([
      { file: 'a.ts', line: 1, name: 'ValidationError' },
      { file: 'a.ts', line: 2, name: 'UpstreamError' },
    ]);
  });

  it('does not match inside a longer word', () => {
    expect(retiredNamesIn('const MyValidationErrors = 1;', 'a.ts')).toEqual([]);
  });
});

describe('the tree', () => {
  /**
   * A removed class named in a doc comment, a README row or a test title tells
   * the next reader to branch on something that no longer exists. The
   * CHANGELOG and the decision records keep them on purpose: they are history.
   */
  it('names no removed error class where a reader would act on it', () => {
    expect(RETIRED_ERROR_NAMES.length).toBe(8);
    expect(retiredNames()).toEqual([]);
  });
});
