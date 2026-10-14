import { parsePutWritesRequest, parseTaskPath } from '../../../../src/checkpointer/internal/parse';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

const config = { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'c1' } };

/**
 * LangGraph 1.5 hands `putWrites` the task's serialized path as a fourth
 * argument (`@langchain/langgraph-checkpoint@1.2.0`), the first component of
 * the order it reads a checkpoint's writes back in. It is stored as given:
 * the empty string is a path too (a write with no task), and absence is what
 * a LangGraph before 1.5 passes.
 */
describe('parseTaskPath', () => {
  it('passes a string through, the empty string included, and reads absence as absence', () => {
    expect(parseTaskPath('~pull, node')).toBe('~pull, node');
    expect(parseTaskPath('')).toBe('');
    expect(parseTaskPath(undefined)).toBeUndefined();
  });

  it('refuses anything that is not a string, naming taskPath', () => {
    for (const value of [null, 7, true, ['~'], {}]) {
      expect(() => parseTaskPath(value)).toThrow(refusal('taskPath'));
    }
  });
});

describe('parsePutWritesRequest carries the task path', () => {
  it('keeps the path it is given, and none when none is given', () => {
    expect(parsePutWritesRequest(config, [['ch', 1]], 'task-1', '~pull, a').taskPath).toBe(
      '~pull, a',
    );
    expect(parsePutWritesRequest(config, [['ch', 1]], 'task-1').taskPath).toBeUndefined();
  });

  it('checks the path after the task id and before the config and the writes', () => {
    expect(() => parsePutWritesRequest(config, [['ch', 1]], 'a#b', 7 as never)).toThrow(
      refusal('taskId'),
    );
    expect(() => parsePutWritesRequest({}, 'nope' as never, 'task-1', 7 as never)).toThrow(
      refusal('taskPath'),
    );
  });
});
