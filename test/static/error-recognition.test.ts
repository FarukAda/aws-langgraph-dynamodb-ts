import { findRecognitionSites, recognitionSites } from './guards/error-recognition';

const at = (source: string, file = 'shared/x.ts'): number[] =>
  findRecognitionSites(source, file).map((site) => site.line);

describe('findRecognitionSites', () => {
  it('flags a name compared with anything, in either order and through a cast', () => {
    expect(at("if (error.name === 'ConditionalCheckFailedException') {}")).toEqual([1]);
    expect(at("if ('NoSuchKey' !== (error as { name?: string }).name) {}")).toEqual([1]);
    expect(at('if (error?.name === EXPECTED) {}')).toEqual([1]);
  });

  it('flags a cancellation reason code compared outside the cancellation module', () => {
    expect(at("if (reasons?.[0]?.Code === 'ConditionalCheckFailed') {}")).toEqual([1]);
    expect(at("if (reason.Code === 'None') {}", 'shared/dynamodb/cancellation.ts')).toEqual([]);
  });

  it('flags an ad-hoc read of a library code, which hasErrorCode replaces', () => {
    expect(at('if ((error as { code?: string }).code === ErrorCode.ABORTED) {}')).toEqual([1]);
  });

  it('flags a switch on a name', () => {
    expect(at("switch (error.name) { case 'X': break; }")).toEqual([1]);
  });

  it('leaves the classifier, a comparison with undefined, and a Node code alone', () => {
    expect(at("if (fields.name === 'X') {}", 'shared/errors/classify.ts')).toEqual([]);
    expect(at('if (reason.Code === undefined) {}')).toEqual([]);
    expect(at("if (err.code === 'ERR_BUFFER_TOO_LARGE') {}")).toEqual([]);
    expect(at("const label = typeof error.name === 'string';")).toEqual([]);
    expect(at('/** error.name === "X" is what a site must not write. */')).toEqual([]);
  });
});

describe('the source tree', () => {
  /**
   * An error is recognised by its code: a library error through `hasErrorCode`,
   * an AWS error through `classifyAwsError`, a cancellation reason through
   * `cancellation.ts`. A name compared at a call site is a second classifier,
   * and it drifts from the first.
   */
  it('recognises no error by name outside the classifier', () => {
    expect(recognitionSites()).toEqual([]);
  });
});
