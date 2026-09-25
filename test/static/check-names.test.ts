import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { namingViolations } from './guards/check-names';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('namingViolations', () => {
  it('refuses a function named validate*, exported or not', () => {
    expect(namingViolations('a.ts', 'function validateX(v: string): void {}')).toEqual([
      'a.ts:1: validateX — validate* is retired: a parse* returns the checked value, an assert* returns nothing',
    ]);
  });

  it('refuses an exported parse* that returns nothing, or declares no return type', () => {
    expect(namingViolations('a.ts', 'export function parseX(v: string): void {}')).toEqual([
      'a.ts:1: parseX — a parse* function returns the value it checked, as a more precise type',
    ]);
    expect(namingViolations('a.ts', 'export function parseX(v: string) { return v; }')).toEqual([
      'a.ts:1: parseX — a parse* function returns the value it checked, as a more precise type',
    ]);
  });

  it('refuses an exported assert* that returns something', () => {
    expect(
      namingViolations('a.ts', 'export function assertX(v: string): string { return v; }'),
    ).toEqual([
      'a.ts:1: assertX — an assert* function returns nothing; one that returns the value is a parse*',
    ]);
  });

  it('accepts the two conventions, and private helpers of any other name', () => {
    const source = [
      'export function parseX(v: unknown): string { return String(v); }',
      'export function assertY(v: string): void {}',
      'export async function assertZ(v: string): Promise<void> {}',
      'function shapeProblems(v: string): void {}',
    ].join('\n');
    expect(namingViolations('a.ts', source)).toEqual([]);
  });

  it('refuses the retired verbs narrow*, require*, check* and checked*, exported or not', () => {
    const source = [
      'export function narrowRow(v: string): string { return v; }',
      'function requireRow(v: string): string { return v; }',
      'function checkShape(v: string): void {}',
      'export function checkedShape(v: string): string { return v; }',
    ].join('\n');
    const reason =
      'is retired: a function returning the checked value is a parse*, one returning nothing an assert*';
    expect(namingViolations('a.ts', source)).toEqual([
      `a.ts:1: narrowRow — narrow* ${reason}`,
      `a.ts:2: requireRow — require* ${reason}`,
      `a.ts:3: checkShape — check* ${reason}`,
      `a.ts:4: checkedShape — checked* ${reason}`,
    ]);
  });

  it('leaves a name that only starts with those letters alone', () => {
    const source = [
      'export function checkpointRowKind(v: string): string { return v; }',
      'function requirements(): void {}',
    ].join('\n');
    expect(namingViolations('a.ts', source)).toEqual([]);
  });

  it('refuses validate* bound to a const arrow function or function expression, exported or not', () => {
    expect(namingViolations('a.ts', 'const validateX = (v: string): void => {};')).toEqual([
      'a.ts:1: validateX — validate* is retired: a parse* returns the checked value, an assert* returns nothing',
    ]);
    expect(
      namingViolations('a.ts', 'export const validateY = function (v: string): void {};'),
    ).toEqual([
      'a.ts:1: validateY — validate* is retired: a parse* returns the checked value, an assert* returns nothing',
    ]);
  });

  it('refuses an exported const parse*/assert* arrow function that breaks the convention', () => {
    expect(namingViolations('a.ts', 'export const parseX = (v: string): void => {};')).toEqual([
      'a.ts:1: parseX — a parse* function returns the value it checked, as a more precise type',
    ]);
    expect(namingViolations('a.ts', 'export const assertX = (v: string): string => v;')).toEqual([
      'a.ts:1: assertX — an assert* function returns nothing; one that returns the value is a parse*',
    ]);
  });

  it('accepts a const parse*/assert* that keeps the convention, and leaves an unexported one unchecked', () => {
    const source = [
      'export const parseX = (v: unknown): string => String(v);',
      'export const assertY = function (v: string): void {};',
      'const parseZ = (v: string): void => {};',
    ].join('\n');
    expect(namingViolations('a.ts', source)).toEqual([]);
  });

  it('refuses a class method named validate*, and a public parse*/assert* method that breaks the convention', () => {
    const source = [
      'class C {',
      '  validateX(v: string): void {}',
      '  parseY(v: string): void {}',
      '  assertZ(v: string): string { return v; }',
      '}',
    ].join('\n');
    expect(namingViolations('a.ts', source)).toEqual([
      'a.ts:2: validateX — validate* is retired: a parse* returns the checked value, an assert* returns nothing',
      'a.ts:3: parseY — a parse* function returns the value it checked, as a more precise type',
      'a.ts:4: assertZ — an assert* function returns nothing; one that returns the value is a parse*',
    ]);
  });

  it('accepts a public class method that keeps the convention, and leaves a private or protected one unchecked', () => {
    const source = [
      'class C {',
      '  parseX(v: unknown): string { return String(v); }',
      '  assertY(v: string): void {}',
      '  private parseZ(v: string): void {}',
      '  protected assertW(v: string): string { return v; }',
      '}',
    ].join('\n');
    expect(namingViolations('a.ts', source)).toEqual([]);
  });
});

describe('the source tree', () => {
  it('uses parse* for a function returning the checked value and assert* for one returning nothing', () => {
    const violations = listSourceFiles().flatMap((path) =>
      namingViolations(relative(SRC_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});
