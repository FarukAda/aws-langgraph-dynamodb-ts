import {
  controlCharacterScanFiles,
  controlCharacters,
  controlCharactersIn,
} from './guards/control-characters';

/** The lone high half of the surrogate pair that spells the grinning-face emoji. */
const HIGH = String.fromCharCode(0xd83d);
/** The lone low half of the surrogate pair that spells the grinning-face emoji. */
const LOW = String.fromCharCode(0xde00);
/** A valid surrogate pair: one character, not a hit. */
const EMOJI = HIGH + LOW;

describe('controlCharactersIn', () => {
  it('flags an unallowed C0 control with its line, column and code point', () => {
    const source = `a${String.fromCharCode(0x01)}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+0001' },
    ]);
  });

  it('flags ESC (U+001B)', () => {
    const source = `a${String.fromCharCode(0x1b)}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+001B' },
    ]);
  });

  it('flags DEL (U+007F)', () => {
    const source = `a${String.fromCharCode(0x7f)}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+007F' },
    ]);
  });

  it('flags a C1 code unit (U+0085, NEL)', () => {
    const source = `a${String.fromCharCode(0x85)}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+0085' },
    ]);
  });

  it('flags the last C1 code unit (U+009F) and stops at the boundary above it', () => {
    const source = `a${String.fromCharCode(0x9f)}b${String.fromCharCode(0xa0)}c`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+009F' },
    ]);
  });

  it('reports the right line and column past the first line', () => {
    const source = `line one\nline t${String.fromCharCode(0x01)}wo`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 2, column: 7, codePoint: 'U+0001' },
    ]);
  });

  it('does not flag tab, LF or CR', () => {
    const source = `a${String.fromCharCode(0x09)}b${String.fromCharCode(0x0d)}c`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([]);
  });

  it('does not flag a valid surrogate pair (an emoji)', () => {
    expect(controlCharactersIn(`a${EMOJI}b`, 'a.ts')).toEqual([]);
  });

  it('does not flag ordinary non-ASCII text', () => {
    const source = `${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x4e2d)} ${EMOJI}`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([]);
  });

  it('flags a trailing lone high surrogate', () => {
    const source = `a${HIGH}`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+D83D' },
    ]);
  });

  it('flags a leading lone low surrogate', () => {
    const source = `${LOW}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 1, codePoint: 'U+DE00' },
    ]);
  });

  it('flags two high surrogates in a row as two lone highs', () => {
    expect(controlCharactersIn(`${HIGH}${HIGH}`, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 1, codePoint: 'U+D83D' },
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+D83D' },
    ]);
  });

  it('does not flag a byte-order mark as the very first character of the file', () => {
    const source = `${String.fromCharCode(0xfeff)}const a = 1;`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([]);
  });

  it('flags a byte-order mark anywhere other than the first character', () => {
    const source = `a${String.fromCharCode(0xfeff)}b`;
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 2, codePoint: 'U+FEFF' },
    ]);
  });

  it('reports each hit on its own line independently', () => {
    const source = [`one${String.fromCharCode(0x01)}`, `two${String.fromCharCode(0x02)}`].join(
      '\n',
    );
    expect(controlCharactersIn(source, 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, column: 4, codePoint: 'U+0001' },
      { file: 'a.ts', line: 2, column: 4, codePoint: 'U+0002' },
    ]);
  });
});

describe('controlCharacters', () => {
  it('finds no raw control character across the real tree', () => {
    expect(controlCharacters()).toEqual([]);
  });

  it('reads the code, the hand-edited docs and the surface baseline, not the generated docs', () => {
    const files = controlCharacterScanFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'src/index.ts',
        'test/surface/harness.mjs',
        'README.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'package.json',
        '.github/workflows/ci.yml',
        'test/surface/baseline.txt',
      ]),
    );
    expect(files.filter((file) => file.startsWith('docs/'))).toEqual([]);
  });
});
