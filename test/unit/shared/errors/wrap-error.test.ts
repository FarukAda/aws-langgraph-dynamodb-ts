import { toError } from '../../../../src/shared/errors/wrap-error';

describe('toError passes an error through', () => {
  it('returns an Error itself, keeping its fields and cause', () => {
    const cause = new Error('why');
    const error = Object.assign(new Error('x', { cause }), { $metadata: { requestId: 'r' } });
    expect(toError(error)).toBe(error);
  });

  /** An SDK error is error-shaped without being an `Error` instance. */
  it('returns any object carrying a string message', () => {
    const sdkLike = { name: 'ThrottlingException', message: 'slow down' } as unknown as Error;
    expect(toError(sdkLike)).toBe(sdkLike);
  });
});

describe('toError describes anything else', () => {
  it('uses a thrown string as the message', () => {
    expect(toError('oops' as unknown as Error).message).toBe('oops');
  });

  it('renders a plain object as JSON', () => {
    expect(toError({ reason: 'nope' } as unknown as Error).message).toBe('{"reason":"nope"}');
  });

  it.each([
    ['undefined', undefined, 'undefined was thrown'],
    ['null', null, 'null was thrown'],
  ])('names %s rather than leaving an empty message', (_name, value, expected) => {
    expect(toError(value as unknown as Error).message).toBe(expected);
  });

  it('names a value JSON renders as nothing', () => {
    expect(toError(Symbol('s') as unknown as Error).message).toBe('a symbol value was thrown');
  });

  /**
   * This runs inside a `catch`. Throwing here would discard the failure the
   * caller is trying to report and replace it with a `TypeError` about JSON.
   */
  it.each([
    [
      'a circular structure',
      (): unknown => {
        const node: Record<string, unknown> = {};
        node.self = node;
        return node;
      },
      'an unserializable object value was thrown',
    ],
    ['a BigInt', (): unknown => 1n, 'an unserializable bigint value was thrown'],
  ])('never throws on %s', (_name, build, expected) => {
    expect(toError(build() as Error).message).toBe(expected);
  });
});
