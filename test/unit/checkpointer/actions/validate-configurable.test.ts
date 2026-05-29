/**
 * Strict unit tests for validateConfigurable
 * (src/checkpointer/actions/validate-configurable.ts).
 *
 * Pure validation: each invalid input throws the exact CheckpointerValidationError
 * type and message from source; valid input returns the parsed ValidatedConfigurable.
 * Boundary rows cover missing/undefined fields, wrong types, empty / control /
 * separator / reserved-prefix strings, and the default checkpoint_ns coercion.
 */
import { validateConfigurable } from '../../../../src/checkpointer/actions/validate-configurable';
import { CheckpointerValidationError } from '../../../../src/checkpointer/utils';
import { THREAD_ID } from '../../../shared/fixtures/test-data';

const SEPARATOR = ':::';

describe('validateConfigurable', () => {
  describe('valid inputs return the parsed configurable', () => {
    it('returns thread_id with defaulted empty checkpoint_ns and undefined checkpoint_id when only thread_id is given', () => {
      expect(validateConfigurable({ thread_id: THREAD_ID })).toEqual({
        thread_id: THREAD_ID,
        checkpoint_ns: '',
        checkpoint_id: undefined,
      });
    }); // AC-17

    it('passes through all three fields when they are valid strings', () => {
      expect(
        validateConfigurable({
          thread_id: THREAD_ID,
          checkpoint_ns: 'ns-a',
          checkpoint_id: 'ckpt-1',
        }),
      ).toEqual({
        thread_id: THREAD_ID,
        checkpoint_ns: 'ns-a',
        checkpoint_id: 'ckpt-1',
      });
    }); // AC-17

    it('coerces an explicit empty-string checkpoint_ns to empty string', () => {
      expect(
        validateConfigurable({ thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: undefined }),
      ).toEqual({ thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: undefined });
    }); // AC-17
  });

  describe('invalid inputs throw CheckpointerValidationError with the exact message', () => {
    const cases: Array<{
      name: string;
      configurable: Record<string, unknown> | undefined;
      message: string;
    }> = [
      { name: 'undefined configurable', configurable: undefined, message: 'Missing configurable' },
      {
        name: 'missing thread_id',
        configurable: { checkpoint_ns: '' },
        message: 'thread_id must be a string',
      },
      {
        name: 'non-string thread_id',
        configurable: { thread_id: 123 },
        message: 'thread_id must be a string',
      },
      {
        name: 'empty thread_id',
        configurable: { thread_id: '' },
        message: 'thread_id cannot be empty',
      },
      {
        name: 'thread_id with separator',
        configurable: { thread_id: `a${SEPARATOR}b` },
        message: `thread_id cannot contain separator "${SEPARATOR}"`,
      },
      {
        name: 'thread_id with control character',
        configurable: { thread_id: 'bad\x00id' },
        message: 'thread_id cannot contain control characters',
      },
      {
        name: 'non-string checkpoint_ns',
        configurable: { thread_id: THREAD_ID, checkpoint_ns: 42 },
        message: 'checkpoint_ns must be a string',
      },
      {
        name: 'checkpoint_ns with separator',
        configurable: { thread_id: THREAD_ID, checkpoint_ns: `x${SEPARATOR}y` },
        message: `checkpoint_ns cannot contain separator "${SEPARATOR}"`,
      },
      {
        name: 'non-string checkpoint_id',
        configurable: { thread_id: THREAD_ID, checkpoint_id: 7 },
        message: 'checkpoint_id must be a string',
      },
      {
        name: 'empty checkpoint_id',
        configurable: { thread_id: THREAD_ID, checkpoint_id: '' },
        message: 'checkpoint_id cannot be empty',
      },
      {
        name: 'checkpoint_id with reserved PAYLOAD# prefix',
        configurable: { thread_id: THREAD_ID, checkpoint_id: 'PAYLOAD#abc' },
        message: 'checkpoint_id cannot begin with "PAYLOAD#" (internal SK reserved prefix)',
      },
    ];

    for (const c of cases) {
      it(`throws "${c.message}" for ${c.name}`, () => {
        let caught: unknown;
        try {
          validateConfigurable(c.configurable);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(CheckpointerValidationError);
        expect((caught as Error).message).toBe(c.message);
      }); // AC-17
    }
  });
});
