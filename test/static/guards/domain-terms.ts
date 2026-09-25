import * as ts from 'typescript';

/** The words of a camelCase, PascalCase or SCREAMING_CASE name, lower-cased. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_]+/)
    .filter((word) => word !== '');
}

/** Every name `source` declares at module level: functions, classes, interfaces, types, enums, variables. */
export function moduleLevelNames(source: string): string[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      );
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      return [statement.name.text];
    }
    return [];
  });
}

/**
 * Deprecated aliases kept for callers, by file relative to `src/`. Each keeps
 * its old term until the major release that removes it.
 */
export const DEPRECATED_NAMES: Readonly<Record<string, readonly string[]>> = {
  'history/session-adapter.ts': ['SessionBackend'],
};

/**
 * Why `name`, declared at module level in `file` (relative to `src/`), uses a
 * term for something else, or `undefined` (decision record 24): a DynamoDB row
 * is a `row`; `item` names the LangGraph store's `Item`, so it appears only
 * under `store/`; `record` is not a noun here — as the first word of a
 * camelCase name it is the verb, and allowed; `backend` is the store's vector
 * backend, so outside `store/` it appears only as `vector backend`; a name in
 * {@link DEPRECATED_NAMES} is exempt.
 */
export function termViolation(file: string, name: string): string | undefined {
  if (DEPRECATED_NAMES[file]?.includes(name) === true) return undefined;
  const words = wordsOf(name);
  const verbFirst = /^[a-z]/.test(name);
  if (!file.startsWith('store/') && words.some((word) => word === 'item' || word === 'items')) {
    return `${file}: ${name} — a DynamoDB row is a row; "item" names the store's Item`;
  }
  if (
    words.some(
      (word, index) => (word === 'record' || word === 'records') && !(index === 0 && verbFirst),
    )
  ) {
    return `${file}: ${name} — a DynamoDB row is a row, not a record`;
  }
  if (
    !file.startsWith('store/') &&
    words.some((word, index) => word === 'backend' && words[index - 1] !== 'vector')
  ) {
    return `${file}: ${name} — "backend" is the store's vector backend`;
  }
  return undefined;
}
