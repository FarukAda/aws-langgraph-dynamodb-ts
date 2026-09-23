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
 * Files allowed to hold a retired name, each for a reason. `ValidationError`
 * is also a common error AWS itself returns, and a reason code it gives a
 * cancelled transaction, which the classifier maps, the names contract cites
 * and the cancellation tests feed in.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'CHANGELOG.md': 'the migration table names what each class became',
  'src/shared/errors/classify.ts': "AWS's own ValidationError common error",
  'test/static/aws-error-names.test.ts': "cites AWS's own ValidationError common error",
  'test/unit/shared/errors/classify.test.ts': "classifies AWS's own ValidationError",
  'test/unit/history/internal/message-transaction.test.ts':
    "AWS's own ValidationError transaction cancellation reason",
  'test/unit/shared/dynamodb/cancellation.test.ts':
    "AWS's own ValidationError transaction cancellation reason",
  'test/unit/shared/dynamodb/retry-classifier.test.ts':
    "AWS's own ValidationError transaction cancellation reason",
  'test/static/guards/retired-error-names.ts': 'this guard lists them',
  'test/static/retired-error-names.test.ts': 'this guard tests them',
};

const PATTERN = new RegExp(`\\b(${RETIRED_ERROR_NAMES.join('|')})\\b`, 'g');

/** Every retired name in `source`, attributed to `file`. */
export function retiredNamesIn(source: string, file: string): RetiredNameHit[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(PATTERN)].map((match) => ({ file, line: index + 1, name: match[1] })),
    );
}

/** Every retired name across source, tests, scripts, examples and root documents. */
export function retiredNames(): RetiredNameHit[] {
  return [...allScannableFiles(), ...handEditedDocFiles()]
    .filter((path) => !Object.hasOwn(ALLOWED, path))
    .flatMap((path) => retiredNamesIn(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path));
}
