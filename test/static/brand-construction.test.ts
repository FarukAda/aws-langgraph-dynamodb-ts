import {
  brandCasts,
  brandViolations,
  declaredBrands,
  sourceModules,
  uniqueSymbolCount,
} from './guards/brands';
import { PARSER_MODULES } from './guards/parser-modules';

const BRANDED = [
  'declare const idBrand: unique symbol;',
  'export type Id = string & { readonly [idBrand]: true };',
  'export type Plain = string;',
].join('\n');

describe('declaredBrands', () => {
  it('finds a type alias keyed by a declared unique symbol, and nothing else', () => {
    expect(declaredBrands(BRANDED)).toEqual(['Id']);
    expect(uniqueSymbolCount(BRANDED)).toBe(1);
    expect(declaredBrands('export type Id = string & { readonly kind: true };')).toEqual([]);
  });
});

describe('brandCasts', () => {
  it('finds as-casts and angle casts to a brand, with the function around them', () => {
    const source = [
      'export function parseId(value: string): Id { return value as Id; }',
      'function other(value: string): Id { return <Id>value; }',
      'const loose = "x" as unknown as Id;',
      'const fine = "x" as string;',
    ].join('\n');
    expect(brandCasts(source, new Set(['Id']))).toEqual([
      { brand: 'Id', line: 1, inFunction: 'parseId' },
      { brand: 'Id', line: 2, inFunction: 'other' },
      { brand: 'Id', line: 3, inFunction: undefined },
    ]);
  });
});

describe('brandViolations', () => {
  const parser = {
    file: 'a/parse.ts',
    source: `${BRANDED}\nexport function parseId(v: string): Id { return v as Id; }`,
  };

  it('accepts a brand cast in exactly one parse* function of the module declaring it', () => {
    expect(brandViolations([parser], ['a/parse.ts'])).toEqual([]);
  });

  it('refuses a brand declared outside a parser module', () => {
    expect(brandViolations([parser], [])).toEqual([
      'a/parse.ts: declares a unique symbol outside a parser module',
    ]);
  });

  it('refuses a cast in another module, outside a parse* function, or a second constructor', () => {
    const elsewhere = {
      file: 'b/use.ts',
      source: 'export function parseId(v: string) { return v as Id; }',
    };
    const helper = {
      file: 'a/parse.ts',
      source: `${parser.source}\nfunction helper(v: string) { return v as Id; }\nexport function parseOther(v: string) { return v as Id; }`,
    };
    expect(brandViolations([parser, elsewhere], ['a/parse.ts'])).toEqual([
      'b/use.ts:1: casts to Id outside a/parse.ts',
    ]);
    expect(brandViolations([helper], ['a/parse.ts'])).toEqual([
      'a/parse.ts: Id is built by 2 parsers (parseId, parseOther); it must have exactly one',
      'a/parse.ts:5: casts to Id outside a parse* function',
    ]);
  });

  it('refuses a brand nothing constructs, and one declared twice', () => {
    const unbuilt = { file: 'a/parse.ts', source: BRANDED };
    const twice = { file: 'c/parse.ts', source: BRANDED };
    expect(brandViolations([unbuilt], ['a/parse.ts'])).toEqual([
      'a/parse.ts: Id is built by 0 parsers (none); it must have exactly one',
    ]);
    expect(brandViolations([parser, twice], ['a/parse.ts', 'c/parse.ts'])).toContain(
      'c/parse.ts: redeclares Id, already declared in a/parse.ts',
    );
  });
});

describe('the source tree', () => {
  it('builds every brand in exactly one parser, in the parser module that declares it', () => {
    expect(brandViolations(sourceModules(), PARSER_MODULES)).toEqual([]);
  });

  it('declares the brands this package parses into', () => {
    const brands = sourceModules()
      .flatMap(({ source }) => declaredBrands(source))
      .sort();
    expect(brands).toEqual([
      'CheckpointId',
      'CheckpointNs',
      'Namespace',
      'NamespacePrefix',
      'PageLimit',
      'ParsedWindow',
      'SessionId',
      'StorableMessages',
      'StoreAddress',
      'TaskId',
      'ThreadId',
      'WriteChannel',
    ]);
  });
});
