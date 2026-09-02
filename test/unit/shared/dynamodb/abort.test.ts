import { abortErrorFrom } from '../../../../src/shared/dynamodb/abort';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { AbortError } from '../../../../src/shared/errors/errors';

describe('abortErrorFrom (DDB-05)', () => {
  it('wraps the DOMException a bare abort() produces as the cause of a library AbortError', () => {
    const controller = new AbortController();
    controller.abort();
    const error = abortErrorFrom(controller.signal);
    expect(error).toMatchObject({ name: 'AbortError', code: ErrorCode.ABORTED });
    expect((error.cause as Error).name).toBe('AbortError');
  });

  it('returns a library AbortError given as the reason unchanged', () => {
    const reason = new AbortError('caller cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortErrorFrom(controller.signal)).toBe(reason);
  });

  it('turns a non-Error reason into the cause and tolerates a missing reason', () => {
    const controller = new AbortController();
    controller.abort('shutting down');
    expect((abortErrorFrom(controller.signal).cause as Error).message).toBe('shutting down');
    const reasonless = { aborted: true, reason: undefined } as unknown as AbortSignal;
    expect(abortErrorFrom(reasonless).cause).toBeUndefined();
  });
});
