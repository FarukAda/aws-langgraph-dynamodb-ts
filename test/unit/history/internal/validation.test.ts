import type { StoredMessage } from '@langchain/core/messages';

import {
  validateMessageWindow,
  validateSessionId,
  validateStorableMessages,
} from '../../../../src/history/internal/validation';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('validateSessionId', () => {
  it('accepts an ordinary session id', () => {
    expect(() => validateSessionId('session-1')).not.toThrow();
  });

  it('rejects an empty or non-string session id', () => {
    expectValidationError(() => validateSessionId(''));
    expectValidationError(() => validateSessionId(null as never));
  });

  it('rejects the reserved separator (M12)', () => {
    expectValidationError(() => validateSessionId('a#b'));
  });

  it('bounds the session id at 1024 bytes and rejects a whitespace-only one (SEC-10)', () => {
    expect(() => validateSessionId('s'.repeat(1024))).not.toThrow();
    expectValidationError(() => validateSessionId('s'.repeat(1025)));
    expectValidationError(() => validateSessionId('  '));
  });

  it('rejects control characters (M7)', () => {
    expectValidationError(() => validateSessionId('s[31m'));
  });
});

describe('validateStorableMessages (HIST-04)', () => {
  const stored = (type: string, data: Record<string, string | undefined>): StoredMessage =>
    ({ type, data: { content: 'c', ...data } }) as StoredMessage;

  it('accepts every message type the read side can rebuild', () => {
    expect(() =>
      validateStorableMessages([
        stored('human', {}),
        stored('ai', {}),
        stored('system', {}),
        stored('tool', { tool_call_id: 'call-1' }),
        stored('function', { name: 'fn' }),
        stored('generic', { role: 'critic' }),
      ]),
    ).not.toThrow();
  });

  it('rejects a type the read side cannot rebuild, naming the offending index and type', () => {
    expect(() =>
      validateStorableMessages([stored('human', {}), stored('remove', { id: 'x' })]),
    ).toThrow(/messages\[1\] of type "remove"/);
    expectValidationError(() => validateStorableMessages([stored('remove', { id: 'x' })]));
  });

  it('rejects a tool message without its tool_call_id, and a function message without a name', () => {
    expectValidationError(() => validateStorableMessages([stored('tool', {})]));
    expectValidationError(() => validateStorableMessages([stored('function', {})]));
  });

  it('accepts an empty list', () => {
    expect(() => validateStorableMessages([])).not.toThrow();
  });
});

describe('validateMessageWindow (HIST-06)', () => {
  it('accepts an empty window, a positive integer limit and a valid Date', () => {
    expect(() => validateMessageWindow({})).not.toThrow();
    expect(() => validateMessageWindow({ limit: 1, before: new Date(0) })).not.toThrow();
  });

  it('rejects a non-positive, fractional or non-numeric limit', () => {
    expectValidationError(() => validateMessageWindow({ limit: 0 }));
    expectValidationError(() => validateMessageWindow({ limit: 2.5 }));
    expectValidationError(() => validateMessageWindow({ limit: '3' as never }));
  });

  it('rejects an invalid Date and a non-Date before', () => {
    expectValidationError(() => validateMessageWindow({ before: new Date('x') }));
    expectValidationError(() => validateMessageWindow({ before: 5 as never }));
    expectValidationError(() => validateMessageWindow({ before: '2024-01-01' as never }));
  });
});
