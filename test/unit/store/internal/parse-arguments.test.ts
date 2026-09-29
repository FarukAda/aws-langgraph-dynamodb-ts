import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  parseListNamespacesOptions,
  parsePutArguments,
} from '../../../../src/store/internal/parse';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

describe('parsePutArguments', () => {
  it('checks the address, then upstream put() namespace rules, then refuses a null value', () => {
    expect(() => parsePutArguments(['a#b'], 'k', null as never, undefined)).toThrow(
      refusal('namespace element'),
    );
    expect(() => parsePutArguments(['a.b'], '', null as never, undefined)).toThrow(refusal('key'));
    expect(() => parsePutArguments(['ns', 'a.b'], 'k', null as never, undefined)).toThrow(
      refusal('namespace element'),
    );
    expect(() => parsePutArguments(['langgraph', 'x'], 'k', {}, undefined)).toThrow(
      refusal('namespace'),
    );
    expect(() => parsePutArguments(['ns'], 'k', null as never, undefined)).toThrow(
      refusal('value'),
    );
  });

  it('reserves "langgraph" only as the root', () => {
    expect(() => parsePutArguments(['ns', 'langgraph'], 'k', {}, undefined)).not.toThrow();
  });

  it('accepts an object value', () => {
    expect(() => parsePutArguments(['ns'], 'k', { a: 1 }, undefined)).not.toThrow();
  });

  /**
   * The retired put-argument check left a non-object, non-null value to the
   * shared check `batch()` (and so `store.put`, which routed through it) ran
   * next — a value such as a bare string reached `store.put` unrefused here
   * and was refused one step later. `parsePutArguments` is now that one step:
   * it is the whole of what `store.put` runs, so it refuses such a value
   * itself instead of deferring it. `store-base-methods.test.ts` pins the
   * public `store.put` still refuses it, unchanged, naming `value`.
   */
  it('refuses a non-object, non-null value itself now, rather than deferring it', () => {
    expect(() => parsePutArguments(['ns'], 'k', 'x' as never, undefined)).toThrow(refusal('value'));
  });
});

describe('parseListNamespacesOptions', () => {
  it("applies upstream's defaults and leaves matchConditions undefined without a path", () => {
    expect(parseListNamespacesOptions({})).toStrictEqual({
      kind: 'list',
      matchConditions: undefined,
      maxDepth: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it('builds a prefix condition before a suffix condition', () => {
    expect(
      parseListNamespacesOptions({
        suffix: ['*'],
        prefix: ['a'],
        maxDepth: 1,
        limit: 0,
        offset: 2,
      }),
    ).toStrictEqual({
      kind: 'list',
      matchConditions: [
        { matchType: 'prefix', path: ['a'] },
        { matchType: 'suffix', path: ['*'] },
      ],
      maxDepth: 1,
      limit: 0,
      offset: 2,
    });
  });

  it('refuses options that are not an object', () => {
    expect(() => parseListNamespacesOptions(null as never)).toThrow(refusal('options'));
  });

  it('ignores an options key LangGraph may add (decision record 28)', () => {
    expect(parseListNamespacesOptions({ foo: 1 } as never)).toEqual({
      kind: 'list',
      matchConditions: undefined,
      maxDepth: undefined,
      limit: 100,
      offset: 0,
    });
  });

  /**
   * The retired options-to-operation builder used to pass every field on to
   * the listing action untouched, including a malformed `prefix`/`maxDepth`/
   * `limit`/`offset`, for it to refuse. `parseListNamespacesOptions` now
   * refuses them itself, in the same order `parseListOperation`'s own tests
   * pin.
   */
  it('refuses malformed paths, maxDepth, limit and offset itself now, rather than deferring them', () => {
    expect(() => parseListNamespacesOptions({ prefix: null as never })).toThrow(refusal('prefix'));
    expect(() => parseListNamespacesOptions({ prefix: ['langgraph'], maxDepth: 0 })).toThrow(
      refusal('maxDepth'),
    );
    expect(() => parseListNamespacesOptions({ limit: -1 })).toThrow(refusal('limit'));
    expect(() => parseListNamespacesOptions({ offset: 1.5 })).toThrow(refusal('offset'));
  });
});
