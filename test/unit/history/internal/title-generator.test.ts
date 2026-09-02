import type { StoredMessage } from '@langchain/core/messages';

import { deriveTitle } from '../../../../src/history/internal/title-generator';

const message = (type: string, content: string): StoredMessage => ({
  type,
  data: { content, role: undefined, name: undefined, tool_call_id: undefined },
});
const human = (content: string): StoredMessage => message('human', content);
const ai = (content: string): StoredMessage => message('ai', content);

describe('deriveTitle', () => {
  it('uses the first human message content', () => {
    expect(deriveTitle([ai('hi'), human('What is DynamoDB?')])).toBe('What is DynamoDB?');
  });

  it('truncates long content with an ellipsis, within the documented maximum (A2)', () => {
    const long = 'a'.repeat(100);
    const title = deriveTitle([human(long)]);
    // Was 81: the ellipsis was appended *after* slicing to the maximum,
    // overshooting the length the doc comment promises.
    expect([...(title as string)]).toHaveLength(80);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair when truncating (M14)', () => {
    // A cut landing mid-emoji left a lone high surrogate: a mangled character
    // that no longer round-trips through UTF-8.
    // 79 filler characters put the emoji's two UTF-16 units astride the
    // 80-unit cut, so a naive slice keeps only its leading high surrogate.
    const emoji = String.fromCodePoint(0x1f600);
    const content = `${'a'.repeat(79)}${emoji} and more text after the cut`;
    const title = deriveTitle([human(content)]) as string;
    const withoutPairs = title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
    expect(/[\uD800-\uDFFF]/.test(withoutPairs)).toBe(false);
    expect(Buffer.from(title, 'utf8').toString('utf8')).toBe(title);
  });

  it('leaves content at exactly the maximum untouched', () => {
    const exact = 'b'.repeat(80);
    expect(deriveTitle([human(exact)])).toBe(exact);
  });

  it('returns undefined when there is no human text', () => {
    expect(deriveTitle([ai('only ai')])).toBeUndefined();
    expect(deriveTitle([human('')])).toBeUndefined();
    expect(deriveTitle([])).toBeUndefined();
  });

  describe('content-block arrays (HIST-10)', () => {
    const blocks = (content: unknown[]): StoredMessage =>
      ({ type: 'human', data: { content } }) as never;

    it('uses the first text block of a multimodal human message', () => {
      const title = deriveTitle([
        blocks([
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'text', text: 'Describe this image' },
          { type: 'text', text: 'second text block' },
        ]),
      ]);
      expect(title).toBe('Describe this image');
    });

    it('returns undefined when no block carries text', () => {
      expect(
        deriveTitle([blocks([{ type: 'image_url', image_url: { url: 'x' } }])]),
      ).toBeUndefined();
      expect(deriveTitle([blocks([{ type: 'text', text: '' }])])).toBeUndefined();
      expect(deriveTitle([blocks([])])).toBeUndefined();
    });

    it('ignores entries that are not block objects and content that is neither string nor array', () => {
      expect(deriveTitle([blocks(['plain string', null, 7, { type: 'text', text: 'ok' }])])).toBe(
        'ok',
      );
      expect(deriveTitle([{ type: 'human', data: {} } as never])).toBeUndefined();
      expect(
        deriveTitle([{ type: 'human', data: { content: { nested: 1 } } } as never]),
      ).toBeUndefined();
    });

    it('truncates block text like string content', () => {
      const title = deriveTitle([blocks([{ type: 'text', text: 'z'.repeat(100) }])]) as string;
      expect([...title]).toHaveLength(80);
      expect(title.endsWith('…')).toBe(true);
    });
  });
});
