/**
 * The release body.
 *
 * A generated list of commit subjects is the wrong artefact for a release
 * carrying breaking changes and upgrade notes: the thing a reader following
 * the link wants is written in the CHANGELOG. This extracts it, and fails
 * rather than shipping an empty body, because an empty release body is the
 * failure nobody notices until someone needs it.
 *
 * `scripts/` is outside jest's coverage collection, so nothing here moves the
 * coverage gate; it runs under `node --test` because `changelog-section.mjs`
 * is an ESM `.mjs` module.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { sectionFor } from '../../scripts/changelog-section.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  'Preamble that belongs to no release.',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- something not yet released',
  '',
  '## [1.2.0] - 2026-09-20',
  '',
  '### Breaking',
  '',
  '- a break worth reading',
  '',
  '### Added',
  '',
  '- an addition',
  '',
  '## [1.1.0] - 2026-08-01',
  '',
  '- older',
  '',
  '[Unreleased]: https://example.invalid/compare/v1.2.0...HEAD',
  '[1.2.0]: https://example.invalid/compare/v1.1.0...v1.2.0',
].join('\n');

describe('sectionFor', () => {
  it('returns the whole of one release section', () => {
    assert.equal(
      sectionFor(CHANGELOG, '1.2.0'),
      ['### Breaking', '', '- a break worth reading', '', '### Added', '', '- an addition'].join(
        '\n',
      ),
    );
  });

  it('stops at the next release rather than running on', () => {
    assert.doesNotMatch(sectionFor(CHANGELOG, '1.2.0'), /older/);
  });

  it('stops before the link-reference footer', () => {
    // The last section in the file has no `## ` after it, only the link refs.
    assert.equal(sectionFor(CHANGELOG, '1.1.0'), '- older');
  });

  it('reads [Unreleased] like any other heading', () => {
    assert.match(sectionFor(CHANGELOG, 'Unreleased'), /something not yet released/);
  });

  it('is undefined for a version with no section', () => {
    assert.equal(sectionFor(CHANGELOG, '9.9.9'), undefined);
  });

  it('is undefined for a section that exists but is empty', () => {
    assert.equal(
      sectionFor('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n## [0.9.0]\n', '1.0.0'),
      undefined,
    );
  });

  it('does not match a different version that shares a prefix', () => {
    const doc =
      '## [1.0.0-rc.2] - 2026-09-21\n\n- rc two\n\n## [1.0.0] - 2026-10-01\n\n- stable\n';
    assert.equal(sectionFor(doc, '1.0.0'), '- stable');
    assert.equal(sectionFor(doc, '1.0.0-rc.2'), '- rc two');
  });

  it('reads the version as text, so a dot in it is a dot', () => {
    // Built into a `RegExp` unescaped, `1.0.0` is a pattern in which each dot
    // stands for any character, and the first heading that fits it wins.
    const doc = '## [1x0y0]\n\n- some other heading\n\n## [1.0.0]\n\n- the release\n';
    assert.equal(sectionFor(doc, '1.0.0'), '- the release');
  });

  it('finds a version that carries build metadata', () => {
    // `+` is a quantifier: unescaped, `1.0.0+b1` never matches its own heading,
    // so a release that has a section would be refused for having none.
    const doc = '## [1.0.0+b1] - 2026-10-01\n\n- a rebuild\n';
    assert.equal(sectionFor(doc, '1.0.0+b1'), '- a rebuild');
  });

  it('reads a CHANGELOG written with CRLF line endings', () => {
    // A checkout with autocrlf turns every heading into `## [x]\r`, and the
    // body would carry a stray carriage return on every line.
    const doc =
      '## [1.0.0] - 2026-10-01\r\n\r\n### Added\r\n\r\n- stable\r\n\r\n## [0.9.0]\r\n\r\n- older\r\n';
    assert.equal(sectionFor(doc, '1.0.0'), '### Added\n\n- stable');
  });

  it('extracts this package’s own current release section', () => {
    // The real file, so a restructuring that breaks extraction fails here
    // rather than producing an empty GitHub Release.
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const body = sectionFor(readFileSync('CHANGELOG.md', 'utf8'), version);
    assert.notEqual(body, undefined);
    assert.ok(body.length > 200);
  });
});
