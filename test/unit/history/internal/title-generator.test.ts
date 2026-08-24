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

  it('truncates long content with an ellipsis', () => {
    const long = 'a'.repeat(100);
    const title = deriveTitle([human(long)]);
    expect(title?.length).toBe(81);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('returns undefined when there is no human text', () => {
    expect(deriveTitle([ai('only ai')])).toBeUndefined();
    expect(deriveTitle([human('')])).toBeUndefined();
    expect(deriveTitle([])).toBeUndefined();
  });
});
