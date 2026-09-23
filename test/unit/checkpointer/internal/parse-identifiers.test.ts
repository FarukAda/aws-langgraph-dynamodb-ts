import {
  parseCheckpointId,
  parseCheckpointNs,
  parsePutWritesRequest,
  parseTaskId,
  parseThreadId,
  parseWriteChannel,
} from '../../../../src/checkpointer/internal/parse';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('the checkpointer identifier parsers', () => {
  it('accepts separator-free identifiers', () => {
    expect(() => parseThreadId('thread-1')).not.toThrow();
    expect(() => parseCheckpointNs('')).not.toThrow();
    expect(() => parseCheckpointNs('a|b')).not.toThrow();
    expect(() => parseCheckpointId('ckpt-1')).not.toThrow();
    expect(() => parseTaskId('task-1')).not.toThrow();
  });

  it('rejects a reserved separator in any segment', () => {
    expectValidationError(() => parseThreadId('thread#1'));
    expectValidationError(() => parseCheckpointNs('ns#x'));
    expectValidationError(() => parseCheckpointId('ckpt#1'));
    expectValidationError(() => parseTaskId('task#1'));
  });

  it('rejects empty thread/checkpoint/task ids', () => {
    expectValidationError(() => parseThreadId(''));
    expectValidationError(() => parseCheckpointId(''));
    expectValidationError(() => parseTaskId(''));
  });

  it('rejects control characters in any identifier (M7)', () => {
    // An unvalidated ANSI escape in an id is a log/terminal-injection surface
    // for any consuming app that writes these values to a raw log.
    expectValidationError(() => parseThreadId('thread\u001b[31m'));
    expectValidationError(() => parseCheckpointNs('ns\u0000'));
    expectValidationError(() => parseCheckpointId('ckpt\u0007'));
    expectValidationError(() => parseTaskId('task\u007f'));
  });

  it('bounds thread_id at 1024 bytes and every sort-key segment at 256 bytes (SEC-10)', () => {
    expect(() => parseThreadId('t'.repeat(1024))).not.toThrow();
    expectValidationError(() => parseThreadId('t'.repeat(1025)));
    expect(() => parseCheckpointNs('n'.repeat(256))).not.toThrow();
    expectValidationError(() => parseCheckpointNs('n'.repeat(257)));
    expect(() => parseCheckpointId('c'.repeat(256))).not.toThrow();
    expectValidationError(() => parseCheckpointId('c'.repeat(257)));
    expect(() => parseTaskId('k'.repeat(256))).not.toThrow();
    expectValidationError(() => parseTaskId('k'.repeat(257)));
  });

  it('rejects whitespace-only ids', () => {
    expectValidationError(() => parseThreadId('   '));
    expectValidationError(() => parseCheckpointId(' '));
    expectValidationError(() => parseTaskId(String.fromCharCode(9)));
  });

  it('still accepts an empty checkpoint namespace, the root namespace (M7)', () => {
    expect(() => parseCheckpointNs('')).not.toThrow();
  });
});

describe('parseWriteChannel (SEC-09)', () => {
  it('applies the key-segment rules to a pending-write channel name', () => {
    expect(() => parseWriteChannel('branch:to:node')).not.toThrow();
    expect(() => parseWriteChannel('c'.repeat(256))).not.toThrow();
    expectValidationError(() => parseWriteChannel(''));
    expectValidationError(() => parseWriteChannel('a#b'));
    expectValidationError(() => parseWriteChannel('c'.repeat(257)));
  });
});

/** A minimal config `parsePutWritesRequest` accepts: a thread and a checkpoint. */
const WRITES_CONFIG = { configurable: { thread_id: 't', checkpoint_id: 'c' } };

describe('the writes shape parsePutWritesRequest checks', () => {
  it('accepts an array of [channel, value] tuples, empty or not', () => {
    expect(() => parsePutWritesRequest(WRITES_CONFIG, [], 'task')).not.toThrow();
    expect(() =>
      parsePutWritesRequest(
        WRITES_CONFIG,
        [
          ['ch', 'a'],
          ['ch', 'b'],
        ],
        'task',
      ),
    ).not.toThrow();
  });

  it('rejects anything that is not an array, naming writes', () => {
    for (const writes of ['x', null, undefined, {}]) {
      expectValidationError(() => parsePutWritesRequest(WRITES_CONFIG, writes as never, 'task'));
    }
  });

  it('rejects an entry that is not itself an array, naming writes with its index', () => {
    expect(() => parsePutWritesRequest(WRITES_CONFIG, [null] as never, 'task')).toThrow(
      /writes\[0\]/,
    );
  });

  /**
   * `validateWrites` used to leave a non-string first element unchecked,
   * deferring to `buildWriteItems`'s own `validateChannel` call so the error
   * would name `channel` rather than `writes` — two functions dividing the
   * work. They are one function now: `parsePutWritesRequest` parses every
   * channel itself, in the same pass that checks the tuple shape, so there is
   * no later call left to defer to.
   */
  it('refuses an entry whose first element is not a string, naming channel', () => {
    expect(() => parsePutWritesRequest(WRITES_CONFIG, [[123, 'v']] as never, 'task')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'channel' } }),
    );
  });
});

describe('parseCheckpointNs applies every rule except non-blank', () => {
  const HIGH = String.fromCharCode(0xd83d);

  it('accepts the empty root namespace', () => {
    expect(() => parseCheckpointNs('')).not.toThrow();
  });

  it('rejects an ill-formed namespace, which reaches both the sort key and the object key', () => {
    expect(() => parseCheckpointNs(`child${HIGH}`)).toThrow(/checkpoint_ns/);
  });
});
