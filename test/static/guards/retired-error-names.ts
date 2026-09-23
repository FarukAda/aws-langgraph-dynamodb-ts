import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { allScannableFiles, handEditedDocFiles } from './plan-references';
import { SRC_ROOT } from './source-files';

/** One mention of a removed error class. */
export interface RetiredNameHit {
  file: string;
  line: number;
  name: string;
}

/**
 * The classes collapsed into `DynamoDBLangGraphError`. `AbortError` is not
 * listed: it is also the name the platform and the SDK give a cancelled
 * request, which the source discusses legitimately.
 */
export const RETIRED_ERROR_NAMES: readonly string[] = [
  'BatchWriteAllIncompleteError',
  'BatchWriteIncompleteError',
  'CompensationFailedError',
  'ConflictError',
  'ResultTruncatedError',
  'RetryExhaustedError',
  'UpstreamError',
  'ValidationError',
];

const REPO_ROOT = resolve(SRC_ROOT, '..');

/**
 * Files allowed to hold any retired name, each for a reason: the history, and
 * the guard's own two files.
 */
const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'CHANGELOG.md': 'the migration table names what each class became',
  'test/static/guards/retired-error-names.ts': 'this guard lists them',
  'test/static/retired-error-names.test.ts': 'this guard tests them',
};

/** One use of a retired spelling that means something else in one file. */
interface AllowedUse {
  file: string;
  /** The exact text allowed; a retired name anywhere else in the file still fails. */
  text: string;
  reason: string;
}

/**
 * `ValidationError` is also a common error AWS itself returns, and a reason
 * code it gives a cancelled transaction. Those spellings are AWS's, not this
 * package's, so each is allowed where it is quoted — and only there.
 */
const ALLOWED_USES: readonly AllowedUse[] = [
  {
    file: 'src/shared/errors/classify.ts',
    text: 'ValidationError: ErrorCode.AWS_REJECTED',
    reason: "maps AWS's own ValidationError common error",
  },
  {
    file: 'src/shared/errors/error-code.ts',
    text: "AWS's `ValidationError` common error",
    reason: "names AWS's own ValidationError common error",
  },
  {
    file: 'test/static/aws-error-names.test.ts',
    text: "ValidationError: 'DynamoDB API Reference, Common Error Types'",
    reason: "cites AWS's own ValidationError common error",
  },
  {
    file: 'test/unit/shared/errors/classify.test.ts',
    text: "cancellation('ValidationError')",
    reason: "classifies AWS's own ValidationError cancellation reason",
  },
  {
    file: 'test/unit/history/internal/append-transaction.test.ts',
    text: "Code: 'ValidationError'",
    reason: "AWS's own ValidationError transaction cancellation reason",
  },
  {
    file: 'test/unit/shared/dynamodb/cancellation.test.ts',
    text: "Code: 'ValidationError'",
    reason: "AWS's own ValidationError transaction cancellation reason",
  },
  {
    file: 'test/unit/shared/dynamodb/retry-classifier.test.ts',
    text: "Code: 'ValidationError'",
    reason: "AWS's own ValidationError transaction cancellation reason",
  },
];

/** A retired name, singular or plural, as a whole word. */
const PATTERN = new RegExp(`\\b(${RETIRED_ERROR_NAMES.join('|')})s?\\b`, 'g');

/**
 * Every retired name in `source`, attributed to `file`. `allowed` — exact
 * texts removed from each line before it is searched, so a name inside one of
 * them is not a hit and a name anywhere else on the same line still is.
 */
export function retiredNamesIn(
  source: string,
  file: string,
  allowed: readonly string[] = [],
): RetiredNameHit[] {
  return source.split('\n').flatMap((line, index) => {
    const searched = allowed.reduce((rest, text) => rest.split(text).join(' '), line);
    return [...searched.matchAll(PATTERN)].map((match) => ({
      file,
      line: index + 1,
      name: match[1],
    }));
  });
}

/** The allowed texts for `file`. */
function allowedIn(file: string): string[] {
  return ALLOWED_USES.filter((use) => use.file === file).map((use) => use.text);
}

/**
 * The allowed uses that no longer occur in their file: an allowance that
 * outlives its text would silently excuse a real mention later.
 */
export function staleAllowedUses(): AllowedUse[] {
  return ALLOWED_USES.filter(
    (use) => !readFileSync(resolve(REPO_ROOT, use.file), 'utf8').includes(use.text),
  );
}

/** Every retired name across source, tests, scripts, examples and root documents. */
export function retiredNames(): RetiredNameHit[] {
  return [...allScannableFiles(), ...handEditedDocFiles()]
    .filter((path) => !Object.hasOwn(ALLOWED_FILES, path))
    .flatMap((path) =>
      retiredNamesIn(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path, allowedIn(path)),
    );
}
