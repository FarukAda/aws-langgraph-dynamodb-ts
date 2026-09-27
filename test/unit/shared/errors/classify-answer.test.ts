import { endedWithoutAnswer } from '../../../../src/shared/errors/classify';

const named = (name: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(name), { name, ...extra });

describe('endedWithoutAnswer', () => {
  it.each([
    ['the SDK request timeout', named('TimeoutError')],
    ['the SDK abort', named('AbortError')],
    ['a reset connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a socket timeout', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    [
      'a cut found beneath a wrapper',
      Object.assign(new Error('wrapped'), { cause: named('TimeoutError') }),
    ],
  ])('is true for %s', (_label, error) => {
    expect(endedWithoutAnswer(error)).toBe(true);
  });

  it.each([
    [
      'a refusal the service answered',
      named('ValidationException', { $metadata: { httpStatusCode: 400 } }),
    ],
    [
      'a throttle the service answered',
      named('ThrottlingException', { $metadata: { httpStatusCode: 400 } }),
    ],
    [
      'a gateway timeout, which is an answer',
      named('TimeoutError', { $metadata: { httpStatusCode: 504 } }),
    ],
    ['an error that says nothing about the transport', new Error('boom')],
    ['nothing at all', undefined],
  ])('is false for %s', (_label, error) => {
    expect(endedWithoutAnswer(error)).toBe(false);
  });

  it('stops at a cycle in the cause chain', () => {
    const loop = new Error('loop');
    loop.cause = loop;
    expect(endedWithoutAnswer(loop)).toBe(false);
  });

  it('gives up on a chain deeper than it will walk, with no cycle to stop it sooner', () => {
    let head = new Error('e0');
    const root = head;
    for (let i = 1; i <= 9; i += 1) {
      const next = new Error(`e${i}`);
      head.cause = next;
      head = next;
    }
    expect(endedWithoutAnswer(root)).toBe(false);
  });
});
