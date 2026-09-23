import {
  crossFeatureImports,
  edgesIn,
  layerOf,
  PERMITTED_UPWARD_IMPORTS,
  sourceEdges,
  sourceFiles,
  staleExceptions,
  upwardImports,
} from './guards/layers';

describe('the layer table', () => {
  it('places modules by directory and by name', () => {
    expect(layerOf('shared/errors/classify.ts')).toBe('shared');
    expect(layerOf('store/types.ts')).toBe('declarations');
    expect(layerOf('history/internal/keys.ts')).toBe('internal');
    expect(layerOf('checkpointer/actions/put.ts')).toBe('actions');
    expect(layerOf('store/store.ts')).toBe('adapter');
    expect(layerOf('factory/types.ts')).toBe('factory');
    expect(layerOf('index.ts')).toBe('entry');
    expect(layerOf('store/new-thing.ts')).toBeUndefined();
  });
});

describe('the checks', () => {
  it('reads type-only imports and re-exports as edges', () => {
    const edges = edgesIn(
      "import type { A } from '../../store/types';\nexport { B } from './b';",
      'shared/validation/x.ts',
    );
    expect(edges).toEqual([
      { from: 'shared/validation/x.ts', to: 'store/types.ts' },
      { from: 'shared/validation/x.ts', to: 'shared/validation/b.ts' },
    ]);
  });

  it('refuses an upward import, and accepts a permitted one', () => {
    const edges = [{ from: 'store/internal/a.ts', to: 'store/actions/get.ts' }];
    expect(upwardImports(edges, [])).toEqual([
      'internal store/internal/a.ts -> actions store/actions/get.ts',
    ]);
    expect(
      upwardImports(edges, [
        { from: 'store/internal/a.ts', to: 'store/actions/get.ts', reason: 'x'.repeat(80) },
      ]),
    ).toEqual([]);
  });

  it('refuses one feature importing another at any layer', () => {
    expect(
      crossFeatureImports([
        { from: 'store/internal/a.ts', to: 'history/types.ts' },
        { from: 'factory/factory.ts', to: 'history/types.ts' },
      ]),
    ).toEqual(['store/internal/a.ts -> history/types.ts']);
  });

  it('reports a permitted exception that no longer matches an import', () => {
    expect(staleExceptions([], [{ from: 'a.ts', to: 'b.ts', reason: 'r' }])).toEqual([
      'a.ts -> b.ts',
    ]);
  });
});

describe('the source tree', () => {
  it('finds the imports to check, so a broken scan cannot pass silently', () => {
    expect(sourceEdges().length).toBeGreaterThanOrEqual(800);
  });

  it('places every module of src/ in a layer', () => {
    expect(sourceFiles().filter((file) => layerOf(file) === undefined)).toEqual([]);
  });

  it('resolves every relative import to a module of src/', () => {
    expect(sourceEdges().filter(({ to }) => layerOf(to) === undefined)).toEqual([]);
  });

  it('lets no module import from a layer above its own', () => {
    expect(upwardImports(sourceEdges())).toEqual([]);
  });

  it('keeps the three features apart', () => {
    expect(crossFeatureImports(sourceEdges())).toEqual([]);
  });

  it('keeps no permitted exception that no longer describes a real import, and explains each', () => {
    expect(staleExceptions(sourceEdges())).toEqual([]);
    expect(PERMITTED_UPWARD_IMPORTS.filter(({ reason }) => reason.trim().length < 80)).toEqual([]);
  });
});
