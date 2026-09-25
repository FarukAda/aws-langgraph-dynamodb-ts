/**
 * Resolve every relative link and `#anchor` in the hand-written documents.
 *
 * Offline by design: an `http(s):` or `mailto:` target is not fetched, so a
 * run never depends on the network. What it checks is what a restructure
 * breaks — a file that moved, a heading that was renamed. Anchors follow
 * GitHub's rule: the heading text lower-cased, every character that is not a
 * letter, digit, space, `-` or `_` dropped, each space turned into `-`, and a
 * repeated heading suffixed `-1`, `-2`. Headings and links inside fenced code
 * and inline code spans are ignored, since a `# comment` in a bash block is
 * not a heading.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './is-main.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A run that reads fewer files than this is broken, not clean. */
const MINIMUM_FILES = 10;

/** The documents a reader navigates: the root guides, the doc indexes, every record and claim. */
export function documentList(root) {
  const fixed = [
    'README.md',
    'CONTRIBUTING.md',
    'SUPPORT.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'CHANGELOG.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ];
  const under = (dir) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `${dir}/${name}`);
  return [...fixed, ...under('docs/decisions'), ...under('docs/evidence')];
}

/** Replace fenced blocks and inline code with blanks, keeping line numbers. */
function withoutCode(text) {
  const lines = text.split(/\r?\n/);
  let fence;
  return lines
    .map((line) => {
      const open = /^\s*(```|~~~)/.exec(line);
      if (fence === undefined && open) {
        fence = open[1];
        return '';
      }
      if (fence !== undefined) {
        if (line.trim().startsWith(fence)) fence = undefined;
        return '';
      }
      return line.replace(/`[^`]*`/g, '');
    })
    .join('\n');
}

/** GitHub's anchor for a heading's text. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a document defines, with GitHub's duplicate suffixes. */
export function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  const source = text.split(/\r?\n/);
  const stripped = withoutCode(text).split('\n');
  stripped.forEach((line, index) => {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) return;
    // Slug the original line: inline code is part of a heading's anchor text.
    const original = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(source[index])[1].replace(/`/g, '');
    const base = slugify(original);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  });
  for (const [, id] of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(id);
  return anchors;
}

/** Every link target in a document, outside code, with its 1-based line. */
export function linksOf(text) {
  const links = [];
  withoutCode(text)
    .split('\n')
    .forEach((line, index) => {
      for (const [, target] of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        links.push({ target, line: index + 1 });
      }
      for (const [, target] of line.matchAll(/href="([^"]+)"/g)) {
        links.push({ target, line: index + 1 });
      }
    });
  return links;
}

/**
 * Accepts: `files`, repository-relative paths; `read`, `isFile` and
 * `isDirectory`, taking a repository-relative path.
 *
 * Returns: one message per link whose file does not exist, or whose `#anchor`
 * the target document does not define.
 */
export function brokenLinks(files, read, isFile, isDirectory) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(read(path)));
    return anchorCache.get(path);
  };
  for (const file of files) {
    for (const { target, line } of linksOf(read(file))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [pathPart, anchor] = target.split('#');
      const path = pathPart === '' ? file : relative('.', join(dirname(file), decodeURI(pathPart))).split('\\').join('/');
      if (pathPart !== '' && !isFile(path) && !isDirectory(path)) {
        problems.push(`${file}:${line}: ${target} — no such file`);
        continue;
      }
      if (anchor !== undefined && path.endsWith('.md') && !anchorsFor(path).has(anchor)) {
        problems.push(`${file}:${line}: ${target} — no heading with anchor #${anchor} in ${path}`);
      }
    }
  }
  return problems;
}

function main() {
  const files = documentList(ROOT).filter((path) => existsSync(join(ROOT, path)));
  if (files.length < MINIMUM_FILES) {
    console.error(`Only ${files.length} documents found (expected at least ${MINIMUM_FILES}).`);
    return 1;
  }
  const full = (path) => resolve(ROOT, path);
  const problems = brokenLinks(
    files,
    (path) => readFileSync(full(path), 'utf8'),
    (path) => existsSync(full(path)) && statSync(full(path)).isFile(),
    (path) => existsSync(full(path)) && statSync(full(path)).isDirectory(),
  );
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  console.log(`${files.length} documents: every relative link and anchor resolves.`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
