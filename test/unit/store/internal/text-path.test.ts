import { getTextAtPath, tokenizePath } from '../../../../src/store/internal/text-path';

const doc = {
  text: 'hello',
  count: 42,
  ok: true,
  none: null,
  meta: { title: 'T', nested: { deep: 'D' } },
  tags: ['a', 'b'],
  list: [{ name: 'x' }, { name: 'y' }],
};

describe('tokenizePath', () => {
  it('splits on dots and isolates bracket and brace groups', () => {
    expect(tokenizePath('meta.title')).toEqual(['meta', 'title']);
    expect(tokenizePath('tags[0]')).toEqual(['tags', '[0]']);
    expect(tokenizePath('list[*].name')).toEqual(['list', '[*]', 'name']);
    expect(tokenizePath('{text,meta.title}')).toEqual(['{text,meta.title}']);
    expect(tokenizePath('')).toEqual([]);
  });

  it('keeps nested brackets or braces inside one token', () => {
    expect(tokenizePath('a[[0]]')).toEqual(['a', '[[0]]']);
    expect(tokenizePath('{a,{b}}')).toEqual(['{a,{b}}']);
  });
});

describe('getTextAtPath', () => {
  it('returns the pretty-printed document for "$"', () => {
    expect(getTextAtPath(doc, '$')).toEqual([JSON.stringify(doc, null, 2)]);
  });

  it('stringifies scalar leaves and pretty-prints object or array leaves', () => {
    expect(getTextAtPath(doc, 'text')).toEqual(['hello']);
    expect(getTextAtPath(doc, 'count')).toEqual(['42']);
    expect(getTextAtPath(doc, 'ok')).toEqual(['true']);
    expect(getTextAtPath(doc, 'meta')).toEqual([JSON.stringify(doc.meta, null, 2)]);
    expect(getTextAtPath(doc, 'tags')).toEqual([JSON.stringify(doc.tags, null, 2)]);
  });

  it('returns nothing for null leaves, missing fields and null intermediates', () => {
    expect(getTextAtPath(doc, 'none')).toEqual([]);
    expect(getTextAtPath(doc, 'missing')).toEqual([]);
    expect(getTextAtPath(doc, 'none.x')).toEqual([]);
  });

  it('indexes arrays positionally, negatively and with a wildcard', () => {
    expect(getTextAtPath(doc, 'tags[0]')).toEqual(['a']);
    expect(getTextAtPath(doc, 'tags[-1]')).toEqual(['b']);
    expect(getTextAtPath(doc, 'tags[5]')).toEqual([]);
    expect(getTextAtPath(doc, 'tags[x]')).toEqual([]);
    expect(getTextAtPath(doc, 'tags[*]')).toEqual(['a', 'b']);
    expect(getTextAtPath(doc, 'list[*].name')).toEqual(['x', 'y']);
    expect(getTextAtPath(doc, 'text[0]')).toEqual([]);
  });

  it('expands a bare wildcard over array items and object values', () => {
    expect(getTextAtPath(doc, 'tags.*')).toEqual(['a', 'b']);
    expect(getTextAtPath(doc, 'meta.nested.*')).toEqual(['D']);
    expect(getTextAtPath(doc, 'text.*')).toEqual([]);
  });

  it('selects several fields with a brace group, pretty-printing non-scalars', () => {
    expect(getTextAtPath(doc, '{text,count,meta.title}')).toEqual(['hello', '42', 'T']);
    expect(getTextAtPath(doc, '{meta}')).toEqual([JSON.stringify(doc.meta, null, 2)]);
    expect(getTextAtPath(doc, '{missing,text}')).toEqual(['hello']);
    expect(getTextAtPath(doc, 'text.{a}')).toEqual([]);
  });

  it('ignores empty fields inside a brace group', () => {
    expect(getTextAtPath(doc, '{text,}')).toEqual(['hello']);
    expect(getTextAtPath(doc, '{}')).toEqual([]);
  });

  it('treats a leading "$" token as the whole document, like the reference', () => {
    expect(getTextAtPath(doc, '$.text')).toEqual([JSON.stringify(doc, null, 2)]);
  });
});
