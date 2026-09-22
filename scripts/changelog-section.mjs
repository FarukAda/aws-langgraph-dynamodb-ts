/**
 * Print one release's section of the CHANGELOG, for the GitHub Release body.
 *
 * The release used `generate_release_notes: true`, which produces a list of
 * commits and pull requests. For a release carrying breaking changes that is
 * the wrong artefact: what breaks, why, and what to do about it all live in
 * the CHANGELOG, and a reader who follows a release link wants those rather
 * than a list of commit subjects.
 *
 * Usage: `node scripts/changelog-section.mjs 1.0.0-rc.2`
 *
 * Exits non-zero if the version has no section, so a release cannot quietly
 * ship an empty body.
 */
import { readFileSync } from 'node:fs';

import { isMain } from './is-main.mjs';

/**
 * Whether a line is `version`'s heading: `## [1.0.0-rc.2] - 2026-09-21`, and the
 * same without a date.
 *
 * Compared as text rather than through a `RegExp` built from the version: a
 * dot there stands for any character, and the `+` of `1.0.0+b1` is a
 * quantifier, so an unescaped pattern matches the wrong heading or cannot
 * match its own. The closing bracket is what keeps `1.0.0` from matching
 * `1.0.0-rc.2`.
 */
const isHeadingFor = (version) => (line) => line.startsWith(`## [${version}]`);

/**
 * The body of `version`'s section: everything after its heading, up to the
 * next `## ` heading or the link-reference footer, whichever comes first.
 *
 * Split on CRLF as well as LF, because a Windows checkout with `core.autocrlf`
 * hands the file over with CRLF endings, and every line of the body would
 * otherwise carry a stray carriage return.
 */
export function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(isHeadingFor(version));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || /^\[[^\]]+\]:\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? undefined : body;
}

if (isMain(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined || version === '') {
    console.error('usage: node scripts/changelog-section.mjs <version>');
    process.exit(2);
  }
  const body = sectionFor(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (body === undefined) {
    console.error(
      `::error::CHANGELOG.md has no section for ${version}. The release body would be empty; ` +
        'add the section, or rename `## [Unreleased]` to this version.',
    );
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}
