import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  findRawMessageReads,
  findRawMessageSites,
  RAW_MESSAGE_RULE,
} from './guards/raw-error-message';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

const lines = (...source: string[]): string => source.join('\n');

describe('findRawMessageReads', () => {
  it('flags the plain read and the cast the defect was written in', () => {
    expect(
      findRawMessageReads('try { f(); } catch (error) { throw new E(error.message); }'),
    ).toEqual([1]);
    expect(
      findRawMessageReads('try { f(); } catch (error) { throw new E((error as Error).message); }'),
    ).toEqual([1]);
  });

  it('flags an interpolation, a concatenation and a context field alike', () => {
    expect(
      findRawMessageReads(
        lines(
          'try { f(); } catch (error) {',
          '  log.warn(`failed: ${(error as Error).message}`);',
          "  throw new E('failed: ' + (error as Error).message, { detail: error.message });",
          '}',
        ),
      ),
    ).toEqual([2, 3]);
  });

  it('flags the destructured and the indexed spellings of the same read', () => {
    expect(
      findRawMessageReads('try { f(); } catch ({ message }) { throw new E(message); }'),
    ).toEqual([1]);
    expect(
      findRawMessageReads("try { f(); } catch (error) { throw new E(error['message']); }"),
    ).toEqual([1]);
  });

  /**
   * The rule is about the error a `catch` binds, not about the word `message`.
   * This package stores LangChain messages, so a guard that matched the text
   * would fire on the write path on every line it touches.
   */
  it('leaves a message that is not the caught error alone', () => {
    expect(findRawMessageReads('const text = item.message;')).toEqual([]);
    expect(findRawMessageReads('function d(value: Error) { return value.message; }')).toEqual([]);
    expect(findRawMessageReads('/** error.message is what a wrapper must not copy. */')).toEqual(
      [],
    );
    expect(findRawMessageReads("const note = 'error.message';")).toEqual([]);
  });

  it('accepts the redacting call the rule asks for', () => {
    expect(
      findRawMessageReads(
        'try { f(); } catch (error) { throw new E(redactedMessage(error as Error)); }',
      ),
    ).toEqual([]);
  });

  /** A nested clause rebinds the name, and its own read is the one reported. */
  it('reports a read inside a nested catch once, at its own line', () => {
    expect(
      findRawMessageReads(
        lines(
          'try { f(); } catch (outer) {',
          '  try { g(); } catch (inner) {',
          '    throw new E(inner.message);',
          '  }',
          '}',
        ),
      ),
    ).toEqual([3]);
  });
});

describe('findRawMessageSites', () => {
  it('names the file and line of each read', () => {
    expect(
      findRawMessageSites([
        {
          path: 'shared/codec/s3/rogue.ts',
          text: 'try { f(); } catch (e) { throw new E(e.message); }',
        },
        { path: 'shared/codec/s3/clean.ts', text: 'try { f(); } catch (e) { throw new E(r(e)); }' },
      ]),
    ).toEqual([{ path: 'shared/codec/s3/rogue.ts', line: 1 }]);
  });
});

/**
 * An upstream message is text this package did not write. The AWS SDK quotes
 * the credential it tried to sign with in its own signing failures, so a
 * wrapper that copies that message verbatim publishes a secret access key and
 * a session token on `err.message` — which an application may print or return
 * with no redacting logger in the path. Two S3 offload sites did exactly that,
 * and a survey, not a rule, is what found them.
 */
describe('the source files that catch an error', () => {
  it('quote a redacted message, never the raw one', () => {
    const sites = findRawMessageSites(
      listSourceFiles().map((path) => ({
        path: relative(SRC_ROOT, path).split('\\').join('/'),
        text: readFileSync(path, 'utf8'),
      })),
    );
    expect(sites).toEqual([]);
    expect(RAW_MESSAGE_RULE).toContain('redactedMessage');
  });
});
