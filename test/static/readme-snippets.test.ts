import { readmeSnippet, snippetDiagnostics } from './guards/readme-snippets';

/**
 * The error-handling example is the one a reader copies into a `catch` block
 * verbatim, so it is compiled from the README itself rather than restated here:
 * an edit to the page that stops it compiling fails this test.
 */
describe('the README error-handling example', () => {
  it('compiles under strict against the package', () => {
    const snippet = readmeSnippet('Error handling');
    expect(snippet).toContain('catch (error)');
    expect(snippetDiagnostics(snippet ?? '')).toEqual([]);
  }, 60000);

  /**
   * The control: a guard called on `error as Error` narrows the cast
   * expression, not `error`, which stays `unknown` — the mistake an earlier
   * version of the example made. Were the compile not really strict, or not
   * really reading the package, this would come back clean.
   */
  it('would reject a guard that narrows a cast instead of the caught value', () => {
    const narrowsTheCast = [
      "import { ErrorCode, isDynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';",
      'try {',
      "  await store.put(['n'], 'k', { v: 1 });",
      '} catch (error) {',
      '  if (isDynamoDBLangGraphError(error as Error)) {',
      '    if (error.code === ErrorCode.VALIDATION) { /* unreachable */ }',
      '  }',
      '}',
    ].join('\n');
    expect(snippetDiagnostics(narrowsTheCast)).toEqual([
      expect.stringMatching(/^TS18046: 'error' is of type 'unknown'/),
    ]);
  }, 60000);
});

describe('readmeSnippet', () => {
  const readme = [
    '## First',
    '```typescript',
    'first();',
    '```',
    '## Second',
    'prose',
    '```typescript',
    'second();',
    '```',
    '## Empty',
    'no code',
    '## After',
  ].join('\n');

  it('returns the first typescript block of the named section', () => {
    expect(readmeSnippet('Second', readme)).toBe('second();');
  });

  it('returns undefined for a missing section, or one without a block', () => {
    expect(readmeSnippet('Absent', readme)).toBeUndefined();
    expect(readmeSnippet('Empty', readme)).toBeUndefined();
    expect(readmeSnippet('After', readme)).toBeUndefined();
  });
});
