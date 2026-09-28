import {
  endedWithoutAnswer,
  mayStillBeInFlight,
  refusedByService,
} from '../../../../src/shared/errors/classify';

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

describe('mayStillBeInFlight', () => {
  it.each([
    ['the SDK request timeout (endedWithoutAnswer)', named('TimeoutError')],
    [
      "DynamoDB's own earlier attempt under this token still being processed",
      named('TransactionInProgressException'),
    ],
    [
      'a server error at the low end of 5xx',
      named('Unknown', { $metadata: { httpStatusCode: 500 } }),
    ],
    [
      'a server error at the high end of 5xx',
      named('Unknown', { $metadata: { httpStatusCode: 599 } }),
    ],
  ])('is true for %s', (_label, error) => {
    expect(mayStillBeInFlight(error)).toBe(true);
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
      'a transaction conflict, which is not the same name',
      named('TransactionConflictException', { $metadata: { httpStatusCode: 400 } }),
    ],
    [
      'a status just below the server-error range',
      named('Unknown', { $metadata: { httpStatusCode: 499 } }),
    ],
    [
      'a status just above the server-error range',
      named('Unknown', { $metadata: { httpStatusCode: 600 } }),
    ],
    ['an error that says nothing about the transport', new Error('boom')],
    ['nothing at all', undefined],
  ])('is false for %s', (_label, error) => {
    expect(mayStillBeInFlight(error)).toBe(false);
  });
});

describe('refusedByService', () => {
  it.each([
    named('ValidationException'),
    named('AccessDeniedException'),
    named('ResourceNotFoundException'),
    named('ConditionalCheckFailedException'),
    Object.assign(named('TransactionCanceledException'), {
      CancellationReasons: [{ Code: 'ValidationError' }],
    }),
  ])('is true for %p', (error) => {
    expect(refusedByService(error)).toBe(true);
  });

  it.each([named('ThrottlingException'), named('TimeoutError'), new Error('boom')])(
    'is false for %p',
    (error) => {
      expect(refusedByService(error)).toBe(false);
    },
  );

  it.each([null, undefined, 'boom', 7])('is total: %p never throws and is false', (value) => {
    expect(refusedByService(value as never)).toBe(false);
  });
});
