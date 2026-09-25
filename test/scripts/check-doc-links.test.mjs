import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anchorsOf, brokenLinks, linksOf, slugify } from '../../scripts/check-doc-links.mjs';

test('slugs a heading the way GitHub does', () => {
  assert.equal(slugify('Store + semantic search'), 'store--semantic-search');
  assert.equal(slugify('Retries and backoff'), 'retries-and-backoff');
  assert.equal(slugify('Migrating from 0.7.x → 0.8.0'), 'migrating-from-07x--080');
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
