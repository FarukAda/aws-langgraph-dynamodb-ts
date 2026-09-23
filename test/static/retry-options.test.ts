import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findRetryCallsWithoutOptions } from './guards/retry-options';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

const readSource = (file: string): string => readFileSync(resolve(SRC_ROOT, file), 'utf8');

describe('findRetryCallsWithoutOptions', () => {
  it('flags a call that passes only the operation', () => {
    const text = 'a\nawait withDynamoDBRetry(() => client.get({ Key: fn(a, b) }));\n';
    expect(findRetryCallsWithoutOptions(text)).toEqual([2]);
  });

  it('accepts a call with options, including a multi-line one with a trailing comma', () => {
    const single = 'withDynamoDBRetry(() => client.get(k), context.retry);';
    const multi = 'withDynamoDBRetry(\n  () => client.get(k),\n  { ...options.retry, signal },\n);';
    expect(findRetryCallsWithoutOptions(single)).toEqual([]);
    expect(findRetryCallsWithoutOptions(multi)).toEqual([]);
  });

  it('does not mistake a trailing comma for a second argument', () => {
    const text = 'withDynamoDBRetry(() =>\n  client.get({ a: "x)" }),\n);';
    expect(findRetryCallsWithoutOptions(text)).toEqual([1]);
  });
});

describe('the per-write deadline stays off the caller-facing surface', () => {
  /**
   * `RetryOptions` is re-exported from the package entry point and is the
   * retry surface `backfillRecencyIndex` accepts, so a new field on it would
   * otherwise be a public option. `deadlineAt` is computed per call by the
   * paths that carry a client request token, never named by an application.
   * The `@internal` marker that keeps it out of the shipped declarations and
   * the generated docs is checked by `internal-seams`, which walks the AST and
   * finds the property wherever it is declared; what is left here is the other
   * half, which no AST walk can see: the key list a caller's options are
   * validated against.
   */
  it('leaves deadlineAt out of the keys backfillRecencyIndex accepts', () => {
    expect(readSource('backfill/backfill.ts')).not.toContain("deadlineAt: 'deadlineAt'");
  });
});

describe('the actual source tree', () => {
  it('passes retry options to every withDynamoDBRetry call outside the retry module itself', () => {
    const offenders = listSourceFiles()
      .filter((path) => !path.replace(/\\/g, '/').endsWith('shared/dynamodb/retry.ts'))
      .flatMap((path) =>
        findRetryCallsWithoutOptions(readFileSync(path, 'utf8')).map((line) => `${path}:${line}`),
      );
    expect(offenders).toEqual([]);
  });
});
