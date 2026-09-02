import { readFileSync } from 'node:fs';

import { findRetryCallsWithoutOptions } from './guards/retry-options';
import { listSourceFiles } from './guards/source-files';

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
