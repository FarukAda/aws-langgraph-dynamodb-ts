import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { moduleLevelNames, termViolation, wordsOf } from './guards/domain-terms';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('wordsOf', () => {
  it('splits camelCase, PascalCase and SCREAMING_CASE', () => {
    expect(wordsOf('parseStoreRow')).toEqual(['parse', 'store', 'row']);
    expect(wordsOf('MAX_TOTAL_ROWS_IN_MEMORY')).toEqual(['max', 'total', 'rows', 'in', 'memory']);
    expect(wordsOf('AWSErrorFields')).toEqual(['aws', 'error', 'fields']);
  });
});

describe('moduleLevelNames', () => {
  it('reads functions, classes, interfaces, types, enums and variables, not locals', () => {
    const source = [
      'export function a() { const local = 1; }',
      'class B {}',
      'interface C {}',
      'type D = 1;',
      'enum E { X }',
      'export const f = 1, g = 2;',
    ].join('\n');
    expect(moduleLevelNames(source)).toEqual(['a', 'B', 'C', 'D', 'E', 'f', 'g']);
  });
});

describe('termViolation', () => {
  it('refuses item for a row outside the store', () => {
    expect(termViolation('history/internal/rows.ts', 'ChatMessageItem')).toBe(
      `history/internal/rows.ts: ChatMessageItem — a DynamoDB row is a row; "item" names the store's Item`,
    );
  });

  it("keeps item for the store's Item", () => {
    expect(termViolation('store/internal/get-item.ts', 'getItem')).toBeUndefined();
  });

  it('refuses record as a noun anywhere, and keeps it as a leading verb', () => {
    expect(termViolation('store/internal/rows.ts', 'StoreItemRecord')).toBe(
      'store/internal/rows.ts: StoreItemRecord — a DynamoDB row is a row, not a record',
    );
    expect(termViolation('shared/dynamodb/retry.ts', 'recordNode')).toBeUndefined();
  });

  it('keeps backend for the vector backend, and refuses it for anything else outside the store', () => {
    expect(
      termViolation('shared/validation/collaborators.ts', 'VECTOR_BACKEND_MEMBERS'),
    ).toBeUndefined();
    expect(termViolation('store/internal/vector-index.ts', 'searchViaBackend')).toBeUndefined();
    expect(termViolation('history/session-adapter.ts', 'SESSION_BACKEND_MEMBERS')).toBe(
      `history/session-adapter.ts: SESSION_BACKEND_MEMBERS — "backend" is the store's vector backend`,
    );
  });
});

describe('the source tree', () => {
  it('finds the modules to check, so a broken scan cannot pass silently', () => {
    expect(listSourceFiles().length).toBeGreaterThanOrEqual(80);
  });

  it('uses one term for each concept in every module-level name', () => {
    const hits = listSourceFiles().flatMap((path) => {
      const file = relative(SRC_ROOT, path).split(sep).join('/');
      return moduleLevelNames(readFileSync(path, 'utf8')).flatMap((name) => {
        const violation = termViolation(file, name);
        return violation === undefined ? [] : [violation];
      });
    });
    expect(hits).toEqual([]);
  });
});
