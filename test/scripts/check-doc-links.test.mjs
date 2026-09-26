import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anchorsOf, brokenLinks, documentList, linksOf, slugify } from '../../scripts/check-doc-links.mjs';

test('slugs a heading the way GitHub does', () => {
  assert.equal(slugify('Store + semantic search'), 'store--semantic-search');
  assert.equal(slugify('Retries and backoff'), 'retries-and-backoff');
  assert.equal(slugify('Migrating from 0.7.x → 0.8.0'), 'migrating-from-07x--080');
});

test('strips a nested tag, which one pass would leave behind', () => {
  assert.equal(slugify('A <<b>i> tag'), 'a-i-tag');
  assert.equal(slugify('A <b><i>x</i></b> tag'), 'a-x-tag');
  assert.equal(slugify('<sup>1</sup> Note'), '1-note');
});

test('numbers repeated headings and ignores headings in code', () => {
  const text = ['## Setup', '```bash', '# not a heading', '```', '## Setup'].join('\n');
  assert.deepEqual([...anchorsOf(text)], ['setup', 'setup-1']);
});

test('keeps inline code inside a heading anchor', () => {
  assert.ok(anchorsOf('### `store.search` paging').has('storesearch-paging'));
});

test('reads markdown and html links outside code', () => {
  const text = 'see [a](b.md#c) and `[x](y.md)`\n<a href="d.md">d</a>';
  assert.deepEqual(linksOf(text).map((l) => l.target), ['b.md#c', 'd.md']);
});

test('reports a missing file and a missing anchor, and skips external links', () => {
  const docs = {
    'README.md': '[ok](docs/x.md#here) [gone](nope.md) [bad](docs/x.md#there) [web](https://a.b) [self](#top)\n# Top',
    'docs/x.md': '## Here',
  };
  const problems = brokenLinks(
    ['README.md'],
    (path) => docs[path],
    (path) => path in docs,
    () => false,
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /nope\.md — no such file/);
  assert.match(problems[1], /#there/);
});

test('resolves reference-style links: full, collapsed and shortcut', () => {
  const text = [
    'A [full form][one], a [collapsed][] and a [Shortcut].',
    '',
    '[one]: a.md',
    '[collapsed]: b.md',
    '[SHORTCUT]: c.md',
  ].join('\n');
  // "[Shortcut]" resolves against "[SHORTCUT]:" — labels match case-insensitively.
  assert.deepEqual(linksOf(text).map((l) => l.target), ['a.md', 'b.md', 'c.md']);
});

test('a reference label with no definition is left alone: it is just text', () => {
  assert.deepEqual(linksOf('[not a link][nope]'), []);
  assert.deepEqual(linksOf('[also not a link]'), []);
});

test('a definition line is not itself read as a use of its own label', () => {
  assert.deepEqual(linksOf('[ref]: a.md'), []);
});

test('reference-style link to a missing file is reported, to an existing file passes', () => {
  const docs = {
    'README.md': [
      'See the [guide][guide-ref] and the [missing one][gone-ref].',
      '',
      '[guide-ref]: docs/x.md#here',
      '[gone-ref]: docs/nope.md',
    ].join('\n'),
    'docs/x.md': '## Here',
  };
  const problems = brokenLinks(
    ['README.md'],
    (path) => docs[path],
    (path) => path in docs,
    () => false,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/nope\.md — no such file/);
});

test('a query string is stripped before resolving the path, keeping the anchor check', () => {
  const docs = {
    'README.md':
      '[ok](docs/x.md?tab=a#here) [bad](docs/x.md?tab=a#missing) [gone](docs/nope.md?tab=a)',
    'docs/x.md': '## Here',
  };
  const problems = brokenLinks(
    ['README.md'],
    (path) => docs[path],
    (path) => path in docs,
    () => false,
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /docs\/nope\.md\?tab=a — no such file/.test(p)));
  assert.ok(problems.some((p) => /#missing/.test(p)));
});

test('documentList includes docs/coding-guidelines.md', () => {
  assert.ok(documentList('this-root-does-not-exist').includes('docs/coding-guidelines.md'));
});

test('documentList does not throw when docs/decisions or docs/evidence is missing', () => {
  const list = documentList('this-root-does-not-exist');
  assert.deepEqual(
    list.filter((path) => path.startsWith('docs/decisions/') || path.startsWith('docs/evidence/')),
    [],
  );
});
