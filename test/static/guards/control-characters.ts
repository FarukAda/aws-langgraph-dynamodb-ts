import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { allScannableFiles, handEditedDocFiles } from './plan-references';
import { SRC_ROOT } from './source-files';

/**
 * One raw control character found in committed source, by file, 1-based line
 * and column, and the offending code point rendered as `U+XXXX`.
 */
export interface ControlCharacterHit {
  file: string;
  line: number;
  column: number;
  codePoint: string;
}

/** The repository root, one level above {@link SRC_ROOT}. */
const REPO_ROOT = resolve(SRC_ROOT, '..');

/**
 * A file this guard reads in addition to {@link allScannableFiles}: the
 * surface baseline is committed text, not `.ts` or `.mjs`, so the shared
 * enumeration never lists it, but a raw character could hide in it exactly as
 * it could anywhere else.
 */
const EXTRA_FILE = 'test/surface/baseline.txt';

/** True for tab (U+0009), line feed (U+000A) and carriage return (U+000D). */
function isAllowedC0(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * True for a code unit that is always a raw control character on its own,
 * independent of its neighbours: C0 other than tab, LF and CR; DEL; and every
 * C1 code unit (U+0080-U+009F).
 */
function isStandaloneControlUnit(code: number): boolean {
  if (code < 0x20) return !isAllowedC0(code);
  if (code === 0x7f) return true;
  return code >= 0x80 && code <= 0x9f;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Zero-width no-break space / byte-order mark. */
const BOM = 0xfeff;

/** `code` rendered the way every hit reports it: `U+` then four-or-more hex digits, upper-case. */
function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Every raw control character in `source`, attributed to `file`.
 *
 * `source` is walked one UTF-16 code unit at a time, tracking a 1-based line
 * and column so a hit can be pointed at directly. A code unit is a hit when
 * it is a standalone control ({@link isStandaloneControlUnit}), a lone
 * surrogate (a high surrogate not immediately followed by a low one, or a low
 * surrogate not immediately preceded by a high one — a valid pair is a single
 * character and never a hit), or {@link BOM} anywhere past the very first
 * character of the file.
 */
export function controlCharactersIn(source: string, file: string): ControlCharacterHit[] {
  const hits: ControlCharacterHit[] = [];
  let line = 1;
  let column = 1;

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);

    if (code === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }

    const isLoneHigh = isHighSurrogate(code) && !isLowSurrogate(source.charCodeAt(index + 1));
    const isLoneLow = isLowSurrogate(code) && !isHighSurrogate(source.charCodeAt(index - 1));
    const isStrayBom = code === BOM && index !== 0;

    if (isStandaloneControlUnit(code) || isLoneHigh || isLoneLow || isStrayBom) {
      hits.push({ file, line, column, codePoint: codePointLabel(code) });
    }

    column += 1;
  }

  return hits;
}

/**
 * Every file this guard's real-tree assertion reads: {@link allScannableFiles},
 * {@link handEditedDocFiles} and {@link EXTRA_FILE}. Nothing is excluded — unlike the plan-vocabulary
 * guard this file borrows its enumeration from, this guard's own two files
 * build every control character they test with at runtime, so they hold none
 * of the raw bytes they look for and need no exclusion.
 */
function scannedFilePaths(): string[] {
  return [...allScannableFiles(), ...handEditedDocFiles(), EXTRA_FILE];
}

/** Every raw control character found across the real tree's scanned files. */
export function controlCharacters(): ControlCharacterHit[] {
  return scannedFilePaths().flatMap((path) =>
    controlCharactersIn(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path),
  );
}
