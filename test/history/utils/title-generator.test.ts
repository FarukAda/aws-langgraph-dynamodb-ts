import { generateTitle } from '../../../src/history/utils';
import { createMockMessage } from '../../shared/fixtures/test-data';

describe('generateTitle', () => {
  it('should generate title from message content', () => {
    const message = createMockMessage('Hello, how are you?');
    const title = generateTitle(message);
    expect(title).toBe('Hello, how are you?');
  });

  it('should truncate long content and add ellipsis', () => {
    const longContent = 'a'.repeat(150);
    const message = createMockMessage(longContent);
    const title = generateTitle(message);
    expect(title).toHaveLength(100);
    expect(title.endsWith('...')).toBe(true);
  });

  it('should clean multiple whitespace', () => {
    const message = createMockMessage('Hello    world   test');
    const title = generateTitle(message);
    expect(title).toBe('Hello world test');
  });

  it('should replace newlines with spaces', () => {
    const message = createMockMessage('Hello\nworld\ntest');
    const title = generateTitle(message);
    expect(title).toBe('Hello world test');
  });

  it('should return default title for empty content', () => {
    const message = createMockMessage('');
    const title = generateTitle(message);
    expect(title).toBe('New Conversation');
  });

  it('should return default title for null message', () => {
    const title = generateTitle(null as any);
    expect(title).toBe('New Conversation');
  });

  it('should handle content with only whitespace', () => {
    const message = createMockMessage('   \n\n   ');
    const title = generateTitle(message);
    expect(title).toBe('New Conversation');
  });

  it('should handle array content with text parts', () => {
    const message = {
      content: [{ text: 'Hello' }, { text: 'world' }, 'from string'],
      type: 'human',
      additional_kwargs: {},
    } as any;
    const title = generateTitle(message);
    expect(title).toBe('Hello world from string');
  });

  it('should handle array content with mixed types', () => {
    const message = {
      content: [
        { text: 'Text part' },
        { type: 'image' }, // Non-text part
        'Direct string',
      ],
      type: 'human',
      additional_kwargs: {},
    } as any;
    const title = generateTitle(message);
    expect(title).toBe('Text part Direct string');
  });

  it('should handle empty array content', () => {
    const message = {
      content: [],
      type: 'human',
      additional_kwargs: {},
    } as any;
    const title = generateTitle(message);
    expect(title).toBe('New Conversation');
  });

  it('should handle array with only non-text parts', () => {
    const message = {
      content: [{ type: 'image' }, { type: 'audio' }],
      type: 'human',
      additional_kwargs: {},
    } as any;
    const title = generateTitle(message);
    expect(title).toBe('New Conversation');
  });
});
