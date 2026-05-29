/**
 * Unit tests for src/history/utils/title-generator.ts.
 *
 * Pinned to the REAL source surface:
 *   export function generateTitle(message: BaseMessage): string;
 *
 * Behaviour pinned from source (resolves all prior TODOs):
 *   - Cap is GENERATED_TITLE_MAX_LENGTH = 100 (internal constant).
 *   - DEFAULT_TITLE = 'New Conversation' for null/undefined message, missing
 *     content, or content that cleans to the empty string.
 *   - Whitespace runs and newlines collapse to a single space, then trim().
 *   - When cleaned.length <= 100 the cleaned string is returned verbatim.
 *   - When cleaned.length > 100 the result is cleaned.substring(0, 97) + '...'
 *     (i.e. exactly 100 chars, last three being the ellipsis).
 *   - Array content concatenates string parts and { text } object parts with ' '.
 *
 * generateTitle takes a SINGLE BaseMessage (not an array). Determinism comes
 * from the deterministic fixtures (no Math.random).
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { generateTitle } from '../../../../src/history/utils/title-generator';
import { makeBaseMessage } from '../../../shared/fixtures/test-data';

const DEFAULT_TITLE = 'New Conversation';
const GENERATED_TITLE_MAX_LENGTH = 100;

describe('title-generator', () => {
  describe('generateTitle (positive)', () => {
    it('returns short content verbatim and is deterministic for identical input', () => {
      const msg = makeBaseMessage({ role: 'human', content: 'Plan a trip to Japan' });
      expect(generateTitle(msg)).toBe('Plan a trip to Japan');
      expect(generateTitle(msg)).toBe('Plan a trip to Japan');
    }); // AC-7

    it('collapses internal whitespace runs and newlines into single spaces and trims', () => {
      const msg = new HumanMessage('  Plan\n\na   trip\tto Japan  ');
      expect(generateTitle(msg)).toBe('Plan a trip to Japan');
    }); // AC-7

    it('returns content of exactly 100 chars unchanged (boundary, no ellipsis)', () => {
      const content = 'a'.repeat(GENERATED_TITLE_MAX_LENGTH);
      const title = generateTitle(new HumanMessage(content));
      expect(title).toBe(content);
      expect(title).toHaveLength(GENERATED_TITLE_MAX_LENGTH);
    }); // AC-7

    it('truncates content of 101 chars to 97 chars + "..." (exactly 100 chars)', () => {
      const content = 'a'.repeat(GENERATED_TITLE_MAX_LENGTH + 1);
      const title = generateTitle(new HumanMessage(content));
      expect(title).toBe('a'.repeat(97) + '...');
      expect(title).toHaveLength(GENERATED_TITLE_MAX_LENGTH);
    }); // AC-7

    it('extracts and joins text from array content parts (string and { text } objects)', () => {
      const msg = new AIMessage({
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'second part' },
        ],
      });
      expect(generateTitle(msg)).toBe('First part second part');
    }); // AC-7

    it('returns a bare string array part verbatim (kills if(typeof part === string) -> false mutant)', () => {
      // The first branch `if (typeof part === 'string') return part;` must keep the
      // raw string element. Mutating it to `if (false)` drops the string and the
      // part would fall through to the object branch, yielding '' instead.
      const msg = new AIMessage({ content: ['hello there'] as unknown as string });
      expect(generateTitle(msg)).toBe('hello there');
    }); // AC-7

    it('maps a mixed array (string, {text}, null, no-text object, number) to only the text parts', () => {
      // Exercises every branch of the part-mapper and pins the exact join result.
      // - 'hi'            -> string branch -> 'hi'
      // - { text:'world'} -> object+text branch -> 'world'
      // - null            -> typeof object but part === null -> ''
      // - { foo: 1 }      -> object, no 'text' key -> ''
      // - 5               -> not string, not object -> ''
      // join(' ') then whitespace-collapse -> 'hi world'.
      // This kills the suite of L35 conditional/logical mutants: any mutant that
      // mis-evaluates the guard either reads `.text`/`'text' in` off null/number
      // (throws) or includes a non-text part (changes the string).
      const msg = new AIMessage({
        content: ['hi', { type: 'text', text: 'world' }, null, { foo: 1 }, 5] as unknown as string,
      });
      expect(generateTitle(msg)).toBe('hi world');
    }); // AC-7

    it('does not throw and includes only text parts when a null element is present (optional-guard safety)', () => {
      const msg = new AIMessage({
        content: [null, { type: 'text', text: 'only' }] as unknown as string,
      });
      let title: string | undefined;
      expect(() => {
        title = generateTitle(msg);
      }).not.toThrow();
      expect(title).toBe('only');
    }); // AC-7
  });

  describe('generateTitle (negative / boundary)', () => {
    it('returns the default title for a message with empty-string content', () => {
      expect(generateTitle(new HumanMessage(''))).toBe(DEFAULT_TITLE);
    }); // AC-7

    it('returns the default title for whitespace-only content that cleans to empty', () => {
      expect(generateTitle(new HumanMessage('   \n\t  '))).toBe(DEFAULT_TITLE);
    }); // AC-7

    it('returns the default title for object (non-string, non-array) content (kills contentText init + Array.isArray mutants)', () => {
      // Content that is a truthy object but neither a string nor an array: source
      // takes neither branch, so contentText stays its '' initializer and cleans to
      // empty -> DEFAULT_TITLE.
      //   - Mutating the `let contentText = ''` initializer to a non-empty literal
      //     would make the function return that literal.
      //   - Mutating `Array.isArray(message.content)` to `true` would run `.map`
      //     on a non-array and throw.
      const msg = { content: { some: 'object' } } as unknown as HumanMessage;
      expect(generateTitle(msg)).toBe(DEFAULT_TITLE);
    }); // AC-7

    it('returns the default title for a null/undefined message', () => {
      // Defensive guard: source short-circuits on a falsy message before reading content.
      expect(generateTitle(null as unknown as HumanMessage)).toBe(DEFAULT_TITLE);
      expect(generateTitle(undefined as unknown as HumanMessage)).toBe(DEFAULT_TITLE);
    }); // AC-7
  });
});
