import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  cosineSimilarity,
  embedValue,
  extractText,
} from '../../../../src/store/internal/semantic-search';
import type { StoreContext } from '../../../../src/store/internal/setup';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it('is 0 for zero or mismatched-length vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe('extractText', () => {
  it('embeds the whole document for "$"', () => {
    expect(extractText({ a: 1 }, ['$'])).toBe(JSON.stringify({ a: 1 }));
  });

  it('extracts specific fields', () => {
    expect(extractText({ title: 'hello', body: 'world' }, ['title', 'body'])).toBe('hello world');
  });
});

describe('embedValue', () => {
  const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5, 0.5]) };

  function context(index?: StoreContext['index']): StoreContext {
    return { client: {} as never, tableName: 's', serde: JSON_SERDE, logger: SILENT_LOGGER, index };
  }

  it('returns undefined when no index is configured', async () => {
    expect(await embedValue(context(), { a: 1 })).toBeUndefined();
  });

  it('embeds the extracted text when an index is configured', async () => {
    const vec = await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['title'] }),
      {
        title: 'hi',
      },
    );
    expect(vec).toEqual([0.5, 0.5]);
    expect(embeddings.embedQuery).toHaveBeenCalledWith('hi');
  });

  it('defaults to embedding the whole document when no fields are configured', async () => {
    embeddings.embedQuery.mockClear();
    await embedValue(context({ dims: 2, embeddings: embeddings as never }), { a: 1 });
    expect(embeddings.embedQuery).toHaveBeenCalledWith(JSON.stringify({ a: 1 }));
  });

  it('uses a fields override when provided', async () => {
    embeddings.embedQuery.mockClear();
    await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['title'] }),
      { title: 'a', body: 'b' },
      ['body'],
    );
    expect(embeddings.embedQuery).toHaveBeenCalledWith('b');
  });

  it('returns undefined when the extracted text is empty', async () => {
    const vec = await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['missing'] }),
      {
        title: 'hi',
      },
    );
    expect(vec).toBeUndefined();
  });
});
