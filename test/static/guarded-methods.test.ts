import { unguardedMethodsIn } from './guards/guarded-methods';

const IMPORT = "import { guardPublic, guardPublicIterable } from './shared/errors/boundary';\n";

describe('unguardedMethodsIn: method bodies', () => {
  const guarded = `${IMPORT}export class A {
    async run(): Promise<void> { return guardPublic('A.run', async () => {}); }
  }`;
  const hoisted = `${IMPORT}export class A {
    async run(opts: object): Promise<void> {
      const { x } = opts as { x: number };
      return guardPublic('A.run', async () => { void x; });
    }
  }`;

  it('accepts a method whose body is a single guardPublic call', () => {
    expect(unguardedMethodsIn(guarded)).toEqual([]);
  });

  it('rejects a statement hoisted above the guard', () => {
    expect(unguardedMethodsIn(hoisted).map((g) => g.name)).toEqual(['A.run']);
  });

  it('refuses a method with neither async nor a declared return type', () => {
    const source = `${IMPORT}export class A { run() { return doSomething(); } }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('does not require a guard from a sync method with a non-Promise return type', () => {
    const source = `${IMPORT}export class A { destroy(): void { releaseHandles(); } }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('accepts an override async method guarded the same way', () => {
    const source = `${IMPORT}export class A {
      override async get(): Promise<void> { return guardPublic('A.get', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('does not exempt a protected method — only private is exempt', () => {
    const source = `${IMPORT}export class A {
      protected async run(): Promise<void> { return this.backend.run(); }
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('exempts a private method regardless of its body', () => {
    const source = `${IMPORT}export class A {
      private async run(): Promise<void> { return this.backend.run(); }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('does not exempt a static method', () => {
    const source = `${IMPORT}export class A {
      static async run(): Promise<void> { return doWork(); }
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('reads a return type declared on a later line than the method name', () => {
    const source = `${IMPORT}export class A {
      reconcile(
        namespacePrefix: string[],
      ): Promise<number> {
        return guardPublic('A.reconcile', () => run(namespacePrefix));
      }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('accepts a non-async AsyncGenerator method guarded with guardPublicIterable', () => {
    const source = `${IMPORT}export class A {
      list(): AsyncGenerator<string> { return guardPublicIterable('A.list', source()); }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('rejects an unguarded non-async AsyncGenerator method', () => {
    const source = `${IMPORT}export class A { list(): AsyncGenerator<string> { return source(); } }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.list']);
  });

  it('ignores the constructor', () => {
    const source = `${IMPORT}export class A { constructor() { doSetup(); } }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('skips a bodyless overload signature and checks only the implementation', () => {
    const source = `${IMPORT}export class A {
      run(x: string): Promise<void>;
      run(x: number): Promise<void>;
      run(x: string | number): Promise<void> {
        return guardPublic('A.run', async () => { void x; });
      }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });
});

describe('unguardedMethodsIn: wrapped guard calls', () => {
  const wrap = (expr: string): string => `${IMPORT}export class A {
    async run(): Promise<void> { return ${expr}; }
  }`;

  it.each([
    ['parenthesized', "(guardPublic('A.run', async () => {}))"],
    ['as-asserted', "guardPublic('A.run', async () => {}) as Promise<void>"],
    ['satisfies-checked', "guardPublic('A.run', async () => {}) satisfies Promise<void>"],
    ['non-null-asserted', "guardPublic('A.run', async () => {})!"],
    ['awaited', "await guardPublic('A.run', async () => {})"],
  ])('accepts a %s guard call', (_label, expr) => {
    expect(unguardedMethodsIn(wrap(expr))).toEqual([]);
  });

  it('still flags a bare expression statement calling the guard, with no return', () => {
    const source = `${IMPORT}export class A {
      async run(): Promise<void> { guardPublic('A.run', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });
});

describe('unguardedMethodsIn: guard identity, not name alone', () => {
  it('refuses a local decoy function named guardPublic, imported from nowhere', () => {
    const source = `function guardPublic(op: string, fn: () => Promise<void>) { return fn(); }
    export class A {
      async run(): Promise<void> { return guardPublic('A.run', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('accepts an aliased import of guardPublic', () => {
    const source = `import { guardPublic as gp } from './shared/errors/boundary';
    export class A {
      async run(): Promise<void> { return gp('A.run', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('refuses a same-named import from a module that is not the boundary', () => {
    const source = `import { guardPublic } from './not-the-boundary';
    export class A {
      async run(): Promise<void> { return guardPublic('A.run', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('resolves the boundary import relative to a nested file, as the real tree does', () => {
    const source = `import { guardPublic } from '../shared/errors/boundary';
    export class A {
      async run(): Promise<void> { return guardPublic('A.run', async () => {}); }
    }`;
    expect(unguardedMethodsIn(source, 'history/session-adapter.ts')).toEqual([]);
  });
});

describe('unguardedMethodsIn: class fields', () => {
  it('accepts a field whose concise arrow body is the guard call', () => {
    const source = `${IMPORT}export class A { load = async () => guardPublic('A.load', async () => {}); }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('rejects a field whose concise arrow body is not the guard call', () => {
    const source = `${IMPORT}export class A { load = async () => doWork(); }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.load']);
  });

  it('accepts a field whose block-body arrow is a single guarded return', () => {
    const source = `${IMPORT}export class A {
      load = async () => { return guardPublic('A.load', async () => {}); };
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('rejects a field with a statement hoisted above the guarded return', () => {
    const source = `${IMPORT}export class A {
      load = async () => {
        const x = 1;
        return guardPublic('A.load', async () => { void x; });
      };
    }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.load']);
  });

  it('refuses a field function with neither async nor a declared return type', () => {
    const source = `${IMPORT}export class A { run = function () { return doWork(); }; }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.run']);
  });

  it('does not require a guard from a field with a non-Promise return type', () => {
    const source = `${IMPORT}export class A { count = (): number => 1; }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('exempts a private field regardless of its body', () => {
    const source = `${IMPORT}export class A { private load = async () => doWork(); }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('ignores a field whose initializer is not a function', () => {
    const source = `${IMPORT}export class A { name = 'x'; }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });
});

describe('unguardedMethodsIn: getters', () => {
  it('accepts a getter declaring a Promise return type with a guarded body', () => {
    const source = `${IMPORT}export class A {
      get value(): Promise<number> { return guardPublic('A.value', async () => 1); }
    }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('rejects an unguarded getter declaring a Promise return type', () => {
    const source = `${IMPORT}export class A { get value(): Promise<number> { return this.load(); } }`;
    expect(unguardedMethodsIn(source).map((g) => g.name)).toEqual(['A.value']);
  });

  it('does not sweep in a getter with no declared return type', () => {
    const source = `${IMPORT}export class A { get value() { return this._value; } }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('does not sweep in a getter with a non-Promise return type', () => {
    const source = `${IMPORT}export class A { get value(): number { return this._value; } }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });

  it('exempts a private getter regardless of its body', () => {
    const source = `${IMPORT}export class A { private get value(): Promise<number> { return this.load(); } }`;
    expect(unguardedMethodsIn(source)).toEqual([]);
  });
});
