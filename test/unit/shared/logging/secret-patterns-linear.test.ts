import { redactSecrets } from '../../../../src/shared/logging/redaction';
import {
  DEFAULT_SECRET_VALUE_PATTERNS,
  REDACTED,
  redactText,
} from '../../../../src/shared/logging/secret-patterns';

/** A real HS256 token: header, payload and signature. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123';

/**
 * Far above what a linear scan of {@link SIZE} characters needs, and far below
 * what a quadratic one does: the JWT pattern this replaced spent about 3 s on
 * 200 KB of `-eyJ`, and 13 s on twice that.
 */
const BUDGET_MS = 1000;
const SIZE = 200_000;

function repeated(unit: string): string {
  return unit.repeat(Math.ceil(SIZE / unit.length));
}

function elapsedMs(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/**
 * `redactSecrets` and `redactLogger` are exported, so a caller can hand them any
 * string — a prompt, a request body — and `redactedMessage` runs them over an
 * error's text before cutting it. Each shape below is one a backtracking
 * pattern could be made to rescan from every position.
 */
describe('the secret value patterns scan in linear time', () => {
  it.each([
    ['"-eyJ" repeated', repeated('-eyJ')],
    ['"-eyJa." repeated', repeated('-eyJa.')],
    ['"eyJ" followed by "a-" repeated', `eyJ${repeated('a-')}`],
    ['"Bearer a" repeated', repeated('Bearer a')],
    ['"token:" followed by whitespace', `token:${' '.repeat(SIZE)}`],
    ['"token:\\"" repeated', repeated('token:"')],
  ])('redacts 200 KB of %s within the budget', (_shape, input) => {
    expect(elapsedMs(() => redactSecrets({ text: input }))).toBeLessThan(BUDGET_MS);
  });

  it('still redacts a real token behind 200 KB of adversarial text in a log argument, within the budget', () => {
    let redacted: ReturnType<typeof redactSecrets> = null;
    const ms = elapsedMs(() => {
      redacted = redactSecrets({ text: `${repeated('-eyJ')} ${JWT}` });
    });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(redacted).toEqual({ text: `${repeated('-eyJ')} ${REDACTED}` });
  });
});

describe('the JWT pattern redacts every shape it redacted before', () => {
  it.each([
    [`token ${JWT} end`, `token ${REDACTED} end`],
    [`"${JWT}"`, `"${REDACTED}"`],
    [`x=${JWT}`, `x=${REDACTED}`],
    [`(${JWT})`, `(${REDACTED})`],
    [`-${JWT}`, `-${REDACTED}`],
    [`a-b-${JWT}-`, `a-b-${REDACTED}-`],
  ])('redacts %j', (input, expected) => {
    expect(redactText(input, DEFAULT_SECRET_VALUE_PATTERNS)).toBe(expected);
  });

  it('redacts a header segment that itself holds "-eyJ" from that point on, leaving only header text', () => {
    expect(redactText('eyJa-eyJb.c.d', DEFAULT_SECRET_VALUE_PATTERNS)).toBe(`eyJa-${REDACTED}`);
  });
});
