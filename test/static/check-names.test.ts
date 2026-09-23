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

  it('accepts the two conventions, and private helpers of any name', () => {
    const source = [
      'export function parseX(v: unknown): string { return String(v); }',
      'export function assertY(v: string): void {}',
      'export async function assertZ(v: string): Promise<void> {}',
      'function checkShape(v: string): void {}',
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
