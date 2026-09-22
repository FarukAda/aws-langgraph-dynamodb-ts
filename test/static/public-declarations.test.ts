import {
  publicDeclarations,
  publicDeclarationsOf,
  publicExports,
  unguardedMethods,
  unguardedPublicMethods,
} from './guards/public-declarations';

const IMPORT = "import { guardPublic } from './shared/errors/boundary';\n";

describe('publicExports', () => {
  it('collects the source name and path of a value export declaration', () => {
    const entry = `export { Foo, Bar } from './x';`;
    expect(publicExports(entry)).toEqual([
      { kind: 'named', name: 'Foo', path: './x' },
      { kind: 'named', name: 'Bar', path: './x' },
    ]);
  });

  it('skips an export type declaration', () => {
    expect(publicExports(`export type { Foo } from './x';`)).toEqual([]);
  });

  it('skips an individual type-only specifier inside a value export list', () => {
    expect(publicExports(`export { type Foo, Bar } from './x';`)).toEqual([
      { kind: 'named', name: 'Bar', path: './x' },
    ]);
  });

  it('records an aliased export by its source name, not the public alias', () => {
    expect(publicExports(`export { Inner as Public } from './a';`)).toEqual([
      { kind: 'named', name: 'Inner', path: './a' },
    ]);
  });

  it('includes a class, function, variable or enum declared and exported directly', () => {
    const entry = [
      'export class Local {}',
      'export async function run(): Promise<void> {}',
      'export const load = async () => 1, limit = 3;',
      'export enum Code { A = "A" }',
      'export interface Shape { a: number }',
      'export type Alias = string;',
      'class Hidden {}',
    ].join('\n');
    expect(publicExports(entry).map((exported) => exported.name)).toEqual([
      'Local',
      'run',
      'load',
      'limit',
      'Code',
    ]);
  });
});

/**
 * An export form the derivation cannot resolve to a declared name must fail
 * the guard, not be skipped: a skipped form is a public value that no guard
 * ever checks, and the real-tree assertion would stay green over it.
 */
describe('publicExports refuses what it cannot resolve by name', () => {
  it.each([
    ['a local export of an imported binding', "import { X } from './a';\nexport { X };"],
    ['a local export of a local binding', 'const X = 1;\nexport { X };'],
    ['an export default of an expression', "import { X } from './a';\nexport default X;"],
    ['an export default class', 'export default class Named {}'],
    ['an export default function', 'export default async function run() {}'],
    ['a re-export of a module default', "export { default } from './a';"],
    ['an aliased re-export of a module default', "export { default as X } from './a';"],
    ['an export * from', "export * from './a';"],
    ['an export * as a namespace', "export * as ns from './a';"],
  ])('throws for %s', (_label, entry) => {
    expect(() => publicExports(entry)).toThrow(/public-declarations: cannot resolve/);
  });
});

describe('publicDeclarationsOf', () => {
  it('resolves each public name to the class, function or value its module declares', () => {
    const entry = `export { A, run, load, Code } from './a';`;
    const modules = {
      './a': [
        'export class A {}',
        'export async function run(): Promise<void> {}',
        'export const load = () => 1;',
        'export enum Code { A = "A" }',
      ].join('\n'),
    };
    expect(publicDeclarationsOf(entry, modules)).toEqual([
      { file: './a', name: 'A', kind: 'class' },
      { file: './a', name: 'run', kind: 'function' },
      { file: './a', name: 'load', kind: 'function' },
      { file: './a', name: 'Code', kind: 'value' },
    ]);
  });

  it('throws for a module that is not supplied', () => {
    expect(() => publicDeclarationsOf(`export { A } from './missing';`, {})).toThrow(
      /cannot read the module \.\/missing/,
    );
  });

  /** The same hole one module down: `import { X } from './b'; export { X };` declares nothing. */
  it('throws for a name the module re-exports rather than declares', () => {
    const entry = `export { X } from './a';`;
    const modules = { './a': "import { X } from './b';\nexport { X };" };
    expect(() => publicDeclarationsOf(entry, modules)).toThrow(/`X` is not a class, function/);
  });

  it('throws for a name the module declares without exporting, or exports only as its default', () => {
    expect(() => publicDeclarationsOf(`export { A } from './a';`, { './a': 'class A {}' })).toThrow(
      /`A` is not a class, function/,
    );
    expect(() =>
      publicDeclarationsOf(`export { A } from './a';`, { './a': 'export default class A {}' }),
    ).toThrow(/`A` is not a class, function/);
  });
});

describe('unguardedPublicMethods', () => {
  it('ignores a class the entry file does not re-export, even in a re-exported module', () => {
    const entry = `export { A } from './a';`;
    const modules = {
      './a': `${IMPORT}export class A { async run(): Promise<void> { return doWork(); } }
      export class B { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['A.run']);
  });

  it('resolves an aliased re-export by the source class name, and flags it when unguarded', () => {
    const entry = `export { Inner as Public } from './a';`;
    const modules = {
      './a': `${IMPORT}export class Inner { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['Inner.run']);
  });

  it('includes a class declared and exported directly in the entry, and flags it when unguarded', () => {
    const entry = `export class Local { async run(): Promise<void> { return doWork(); } }`;
    expect(unguardedPublicMethods(entry, {}).map((g) => g.name)).toEqual(['Local.run']);
  });

  it('flags an unguarded exported function, and not an unexported helper beside it', () => {
    const entry = `export { tool } from './a';`;
    const modules = {
      './a': `${IMPORT}async function helper(): Promise<void> { await doWork(); }
      export async function tool(): Promise<void> { await helper(); }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['tool']);
  });

  it('accepts an exported function whose body is one guarded return', () => {
    const entry = `export { tool } from './a';`;
    const modules = {
      './a': `${IMPORT}export async function tool(): Promise<void> {
        return guardPublic('tool', async () => { await doWork(); });
      }`,
    };
    expect(unguardedPublicMethods(entry, modules)).toEqual([]);
  });

  it('flags an unguarded function held in an exported variable, and one declared in the entry', () => {
    const entry = `export { tool } from './a';\nexport const local = async () => doWork();`;
    const modules = { './a': `${IMPORT}export const tool = (): Promise<void> => doWork();` };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['tool', 'local']);
  });

  it('holds no rule over a synchronous function or a non-function value', () => {
    const entry = `export { check, Code } from './a';`;
    const modules = {
      './a': `export function check(value: Error): value is Error { return true; }
      export enum Code { A = 'A' }`,
    };
    expect(unguardedPublicMethods(entry, modules)).toEqual([]);
  });
});

/**
 * The rule this guard exists to hold: every public member of a class, and
 * every function, `src/index.ts` makes part of the public API either cannot be
 * proven synchronous, or takes the exact shape that routes its rejection
 * through the error boundary. A class or function declared `export` but not
 * re-exported — internal plumbing such as `S3Offloader` — is out of scope,
 * since its errors are branded at the public boundary that calls it, not at
 * every internal layer.
 */
describe('the public API', () => {
  it('leaves no public member or function unguarded', () => {
    expect(unguardedMethods()).toEqual([]);
  });

  /**
   * The positive control: an empty derivation would leave the assertion above
   * green with nothing checked, so the adapters, the factory and the one public
   * async function must each be found.
   */
  it('derives every adapter, the factory and backfillRecencyIndex from src/index.ts', () => {
    const names = publicDeclarations().map(({ name, kind }) => `${kind} ${name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'class DynamoDBSaver',
        'class DynamoDBStore',
        'class DynamoDBChatMessageHistory',
        'class DynamoDBSessionChatMessageHistory',
        'class DynamoDBFactory',
        'function backfillRecencyIndex',
      ]),
    );
  });
});
