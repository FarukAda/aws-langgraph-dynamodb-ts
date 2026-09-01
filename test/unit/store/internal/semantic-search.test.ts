import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  assertVectorDims,
  cosineSimilarity,
  embedValue,
  embedValues,
  extractText,
} from '../../../../src/store/internal/semantic-search';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { stubEmbeddings } from '../../../shared/helpers/embeddings-stub';

function context(index?: StoreContext['index']): StoreContext {
  return {
    client: {} as never,
    tableName: 's',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    index,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

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
  it('embeds the pretty-printed whole document for "$", like InMemoryStore', () => {
    expect(extractText({ a: 1 }, ['$'])).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('extracts specific fields', () => {
    expect(extractText({ title: 'hello', body: 'world' }, ['title', 'body'])).toBe('hello world');
  });

  it('extracts non-string leaves and wildcards like InMemoryStore', () => {
    const value = { n: 3, ok: true, list: [{ name: 'x' }] };
    expect(extractText(value, ['n', 'ok', 'list[*].name'])).toBe('3 true x');
  });

  it('does not throw on a null intermediate', () => {
    expect(extractText({ a: null }, ['a.b'])).toBe('');
  });
});

describe('embedValue', () => {
  it('returns undefined when no index is configured', async () => {
    expect(await embedValue(context(), { a: 1 })).toBeUndefined();
  });

  it('embeds the extracted text with embedDocuments when an index is configured', async () => {
    const embeddings = stubEmbeddings([0.5, 0.5]);
    const vec = await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['title'] }),
      { title: 'hi' },
    );
    expect(vec).toEqual([0.5, 0.5]);
    expect(embeddings.embedDocuments).toHaveBeenCalledWith(['hi']);
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it('defaults to embedding the whole document when no fields are configured', async () => {
    const embeddings = stubEmbeddings([0.5, 0.5]);
    await embedValue(context({ dims: 2, embeddings: embeddings as never }), { a: 1 });
    expect(embeddings.embedDocuments).toHaveBeenCalledWith([JSON.stringify({ a: 1 }, null, 2)]);
  });

  it('uses a fields override when provided', async () => {
    const embeddings = stubEmbeddings([0.5, 0.5]);
    await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['title'] }),
      { title: 'a', body: 'b' },
      ['body'],
    );
    expect(embeddings.embedDocuments).toHaveBeenCalledWith(['b']);
  });

  it('returns undefined without calling the embeddings when the extracted text is empty', async () => {
    const embeddings = stubEmbeddings([0.5, 0.5]);
    const vec = await embedValue(
      context({ dims: 2, embeddings: embeddings as never, fields: ['missing'] }),
      { title: 'hi' },
    );
    expect(vec).toBeUndefined();
    expect(embeddings.embedDocuments).not.toHaveBeenCalled();
  });

  it('throws a ValidationError when the embeddings return a vector of the wrong length', async () => {
    const embeddings = stubEmbeddings([1, 2, 3]);
    const ctx = context({ dims: 2, embeddings: embeddings as never, fields: ['t'] });
    await expect(embedValue(ctx, { t: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('embedValues', () => {
  it('embeds every non-empty text in one embedDocuments call and keeps order', async () => {
    const embedDocuments = jest.fn(async (texts: string[]) => texts.map((t) => [t.length]));
    const embeddings = { embedQuery: jest.fn(), embedDocuments };
    const ctx = context({ dims: 1, embeddings: embeddings as never, fields: ['t'] });
    const vectors = await embedValues(ctx, [{ t: 'ab' }, { t: '' }, { t: 'abcd' }]);
    expect(vectors).toEqual([[2], undefined, [4]]);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedDocuments).toHaveBeenCalledWith(['ab', 'abcd']);
  });

  it('splits large inputs into batches of 100', async () => {
    const embedDocuments = jest.fn(async (texts: string[]) => texts.map(() => [1]));
    const embeddings = { embedQuery: jest.fn(), embedDocuments };
    const ctx = context({ dims: 1, embeddings: embeddings as never, fields: ['t'] });
    await embedValues(
      ctx,
      Array.from({ length: 250 }, (_, i) => ({ t: `v${i}` })),
    );
    expect(embedDocuments.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 50]);
  });

  it('returns undefined for every value when no index is configured', async () => {
    expect(await embedValues(context(), [{ a: 1 }, { b: 2 }])).toEqual([undefined, undefined]);
  });
});

describe('assertVectorDims', () => {
  const index = (dims: number) => ({ dims, embeddings: {} as never });

  it('rejects a vector whose length disagrees with index.dims', () => {
    expect(() => assertVectorDims(index(3), [1, 2], 'document')).toThrow(/index\.dims/);
  });

  it('accepts a matching vector', () => {
    expect(() => assertVectorDims(index(2), [1, 2], 'query')).not.toThrow();
  });

  it('skips the check when dims is not a positive integer', () => {
    expect(() => assertVectorDims(index(0), [1, 2], 'query')).not.toThrow();
    expect(() => assertVectorDims(index(Number.NaN), [1, 2], 'query')).not.toThrow();
  });
});
