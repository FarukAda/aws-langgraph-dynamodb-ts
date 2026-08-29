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
});
