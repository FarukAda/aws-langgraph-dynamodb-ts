import { MAX_LOGGED_LABELS, MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { truncateForLog, truncateLabelsForLog } from '../../../../src/shared/logging/truncate';

/** The lone high half of the surrogate pair that spells the grinning-face emoji. */
const HIGH = String.fromCharCode(0xd83d);

describe('truncateForLog', () => {
  it('returns a value at or under the cap unchanged', () => {
    expect(truncateForLog('META##c1')).toBe('META##c1');
    expect(truncateForLog('')).toBe('');
    expect(truncateForLog('x'.repeat(MAX_LOGGED_VALUE_CHARS))).toHaveLength(MAX_LOGGED_VALUE_CHARS);
  });

  /**
   * The mark says the value was cut and how long it really was, so a reader
   * can tell a truncated key from one that simply ends there and can still
   * match the line against the row.
   */
  it('keeps a readable head and states the full length', () => {
    const value = `${'a'.repeat(MAX_LOGGED_VALUE_CHARS)}bbbb`;
    expect(truncateForLog(value)).toBe(
      `${'a'.repeat(MAX_LOGGED_VALUE_CHARS)}…(len ${MAX_LOGGED_VALUE_CHARS + 4})`,
    );
  });

  /**
   * A cut through a surrogate pair would leave a lone surrogate in the line —
   * the one thing `assertWellFormed` keeps out of this package's strings, and
   * what a JSON transport silently rewrites to U+FFFD.
   */
  it('never cuts a surrogate pair in half', () => {
    const value = `${'a'.repeat(MAX_LOGGED_VALUE_CHARS - 1)}😀tail`;
    const out = truncateForLog(value);
    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe(`${'a'.repeat(MAX_LOGGED_VALUE_CHARS - 1)}…(len ${value.length})`);
  });

  /**
   * A row attribute is whatever was written into the row. The call sites type
   * it `string` because a table's own key attributes always are, but a warning
   * about a row that is already wrong is the last place to raise a `TypeError`
   * of its own, so anything else is passed through exactly as it logged before.
   */
  it('passes a non-string through rather than throwing inside a warning', () => {
    expect(truncateForLog(undefined as unknown as string)).toBeUndefined();
    expect(truncateForLog(7 as unknown as string)).toBe(7);
  });

  it('leaves a lone surrogate already in the value alone', () => {
    expect(truncateForLog(`a${HIGH}b`)).toBe(`a${HIGH}b`);
  });
});

describe('truncateLabelsForLog', () => {
  it('returns a namespace within both bounds unchanged', () => {
    expect(truncateLabelsForLog(['users', 'u1'])).toEqual(['users', 'u1']);
    expect(truncateLabelsForLog([])).toEqual([]);
  });

  /**
   * An array is two unbounded things, the number of labels and the length of
   * each, so bounding only the labels is not a bound: a backend returning one
   * label of a megabyte and one returning a million labels of a character cost
   * the same line.
   */
  it('bounds the number of labels and states the depth it really had', () => {
    const deep = Array.from({ length: MAX_LOGGED_LABELS + 3 }, (_unused, at) => `l${at}`);
    expect(truncateLabelsForLog(deep)).toEqual([
      ...deep.slice(0, MAX_LOGGED_LABELS),
      `…(len ${MAX_LOGGED_LABELS + 3})`,
    ]);
  });

  it('bounds each label it keeps', () => {
    const long = 'x'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    expect(truncateLabelsForLog(['users', long])).toEqual(['users', truncateForLog(long)]);
  });

  /**
   * These lines report a namespace `validateStoreKey` has just refused, and a
   * namespace that is not an array at all is one of the things it refuses, so
   * the non-array is the reported value rather than a defensive guard.
   */
  it('passes a namespace that is not an array through rather than throwing inside a warning', () => {
    expect(truncateLabelsForLog(undefined as unknown as string[])).toBeUndefined();
    expect(truncateLabelsForLog('users#u1' as unknown as string[])).toBe('users#u1');
  });

  it('passes a label that is not a string through, for the same reason', () => {
    expect(truncateLabelsForLog([7 as unknown as string])).toEqual([7]);
  });
});
