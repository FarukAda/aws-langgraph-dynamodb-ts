import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertPutArguments,
  listNamespacesOperation,
} from '../../../../src/store/internal/call-arguments';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

describe('assertPutArguments', () => {
  it('checks the address, then upstream put() namespace rules, then refuses a null value', () => {
    expect(() => assertPutArguments(['a#b'], 'k', null as never)).toThrow(
      refusal('namespace element'),
    );
    expect(() => assertPutArguments(['a.b'], '', null as never)).toThrow(refusal('key'));
    expect(() => assertPutArguments(['ns', 'a.b'], 'k', null as never)).toThrow(
      refusal('namespace element'),
    );
    expect(() => assertPutArguments(['langgraph', 'x'], 'k', {})).toThrow(
      refusal('namespace element'),
    );
    expect(() => assertPutArguments(['ns'], 'k', null as never)).toThrow(refusal('value'));
  });

  it('reserves "langgraph" only as the root', () => {
    expect(() => assertPutArguments(['ns', 'langgraph'], 'k', {})).not.toThrow();
  });

  it('leaves every other value to the put action', () => {
    expect(() => assertPutArguments(['ns'], 'k', { a: 1 })).not.toThrow();
    expect(() => assertPutArguments(['ns'], 'k', 'x' as never)).not.toThrow();
  });
});

describe('listNamespacesOperation', () => {
  it("applies upstream's defaults and leaves matchConditions undefined without a path", () => {
    expect(listNamespacesOperation({})).toStrictEqual({
      matchConditions: undefined,
      maxDepth: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it('builds a prefix condition before a suffix condition', () => {
    expect(
      listNamespacesOperation({ suffix: ['*'], prefix: ['a'], maxDepth: 1, limit: 0, offset: 2 }),
    ).toStrictEqual({
      matchConditions: [
        { matchType: 'prefix', path: ['a'] },
        { matchType: 'suffix', path: ['*'] },
      ],
      maxDepth: 1,
      limit: 0,
      offset: 2,
    });
  });

  it('passes a null path on as a condition, for the listing action to refuse', () => {
    expect(listNamespacesOperation({ prefix: null as never }).matchConditions).toStrictEqual([
      { matchType: 'prefix', path: null },
    ]);
  });

  it('refuses options that are not an object or carry a key it does not read', () => {
    expect(() => listNamespacesOperation(null as never)).toThrow(refusal('options'));
    expect(() => listNamespacesOperation({ foo: 1 } as never)).toThrow(refusal('options.foo'));
  });

  it('leaves the paths, maxDepth, limit and offset to the action that runs the operation', () => {
    expect(
      listNamespacesOperation({ prefix: ['langgraph'], maxDepth: 0, limit: -1, offset: 1.5 }),
    ).toMatchObject({ maxDepth: 0, limit: -1, offset: 1.5 });
  });
});
