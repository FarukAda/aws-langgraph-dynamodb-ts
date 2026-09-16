import {
  reExportedClasses,
  unguardedMethods,
  unguardedPublicMethods,
} from './guards/public-classes';

const IMPORT = "import { guardPublic } from './shared/errors/boundary';\n";

describe('reExportedClasses', () => {
  it('collects the source name and path of a value export declaration', () => {
    const entry = `export { Foo, Bar } from './x';`;
    expect(reExportedClasses(entry)).toEqual([
      { kind: 'named', name: 'Foo', path: './x' },
      { kind: 'named', name: 'Bar', path: './x' },
    ]);
  });

  it('skips an export type declaration', () => {
    expect(reExportedClasses(`export type { Foo } from './x';`)).toEqual([]);
  });

  it('skips an individual type-only specifier inside a value export list', () => {
    expect(reExportedClasses(`export { type Foo, Bar } from './x';`)).toEqual([
      { kind: 'named', name: 'Bar', path: './x' },
    ]);
  });

  it('ignores an export declaration with no module specifier', () => {
    expect(reExportedClasses(`const Foo = 1;\nexport { Foo };`)).toEqual([]);
  });

  it('records an aliased export by its source name, not the public alias', () => {
    expect(reExportedClasses(`export { Inner as Public } from './a';`)).toEqual([
      { kind: 'named', name: 'Inner', path: './a' },
    ]);
  });

  it('turns export * into an "all" locator for that module', () => {
    expect(reExportedClasses(`export * from './a';`)).toEqual([{ kind: 'all', path: './a' }]);
  });

  it('turns export { default } into a "default" locator', () => {
    expect(reExportedClasses(`export { default } from './a';`)).toEqual([
      { kind: 'default', path: './a' },
    ]);
  });

  it('turns export { default as X } into the same "default" locator', () => {
    expect(reExportedClasses(`export { default as X } from './a';`)).toEqual([
      { kind: 'default', path: './a' },
    ]);
  });

  it('includes a class declared and exported directly, with no from', () => {
    expect(reExportedClasses(`export class Local {}`)).toEqual([{ kind: 'local', name: 'Local' }]);
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

  it('ignores a re-export whose module is not supplied', () => {
    expect(unguardedPublicMethods(`export { A } from './missing';`, {})).toEqual([]);
  });

  it('resolves an aliased re-export by the source class name, and flags it when unguarded', () => {
    const entry = `export { Inner as Public } from './a';`;
    const modules = {
      './a': `${IMPORT}export class Inner { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['Inner.run']);
  });

  it('an export * pulls in every exported class of that module', () => {
    const entry = `export * from './a';`;
    const modules = {
      './a': `${IMPORT}export class A { async run(): Promise<void> { return doWork(); } }
      export class B { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(
      unguardedPublicMethods(entry, modules)
        .map((g) => g.name)
        .sort(),
    ).toEqual(['A.run', 'B.run']);
  });

  it('an export * does not pull in a class the module does not itself export', () => {
    const entry = `export * from './a';`;
    const modules = {
      './a': `${IMPORT}export class A { async run(): Promise<void> { return doWork(); } }
      class Internal { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['A.run']);
  });

  it('export { default } resolves to the module anonymous default export', () => {
    const entry = `export { default } from './a';`;
    const modules = {
      './a': `${IMPORT}export default class { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['default.run']);
  });

  it('export { default as X } resolves to the module named default export', () => {
    const entry = `export { default as X } from './a';`;
    const modules = {
      './a': `${IMPORT}export default class Named { async run(): Promise<void> { return doWork(); } }`,
    };
    expect(unguardedPublicMethods(entry, modules).map((g) => g.name)).toEqual(['Named.run']);
  });

  it('includes a class declared and exported directly in the entry, and flags it when unguarded', () => {
    const entry = `export class Local { async run(): Promise<void> { return doWork(); } }`;
    expect(unguardedPublicMethods(entry, {}).map((g) => g.name)).toEqual(['Local.run']);
  });
});

/**
 * The rule this guard exists to hold: every public member of a class
 * `src/index.ts` makes part of the public API either cannot be proven
 * synchronous, or takes the exact shape that routes its rejection through
 * the error boundary. A class declared `export` but not re-exported —
 * internal plumbing such as `S3Offloader` — is out of scope, since its
 * errors are branded at the public boundary that calls it, not at every
 * internal layer.
 */
describe('the public API', () => {
  it('leaves no public member unguarded', () => {
    expect(unguardedMethods()).toEqual([]);
  });
});
