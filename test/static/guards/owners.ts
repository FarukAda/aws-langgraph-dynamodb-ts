import * as ts from 'typescript';

/**
 * The modules allowed to compose a key or name a key attribute, relative to
 * `src/`: the table-wide conventions and each feature's row format. Every other
 * module takes a key from one of them (decision record 22), which is what keeps
 * a change to a key layout inside one module.
 */
export const KEY_SCHEMA_OWNERS: readonly string[] = [
  'shared/dynamodb/table-schema.ts',
  'checkpointer/internal/rows.ts',
  'history/internal/rows.ts',
  'store/internal/rows.ts',
];

/**
 * The one module that reads or writes a SESSION row's `messageCount`. The
 * count is a copy of how many message rows the session holds, and a copy with
 * two writers drifts (rule 91 of the coding guidelines).
 */
export const MESSAGE_COUNT_OWNER = 'history/internal/session.ts';

/**
 * The one module that calls a `VectorBackend`. The backend holds a copy of the
 * items' embeddings; the table is the truth, and one module decides when the
 * copy is written, dropped, searched and repaired.
 */
export const VECTOR_COPY_OWNER = 'store/internal/vector-index.ts';

/** A key attribute's name as a whole word, inside any string or template piece. */
const KEY_ATTRIBUTE_WORD = /\b[PS]K\b/;

/** Methods only a `VectorBackend` has. */
const BACKEND_ONLY_METHODS: readonly string[] = ['upsert', 'listKeys'];

/** Methods a `VectorBackend` shares with the DynamoDB client, told apart by their receiver. */
const SHARED_METHODS: readonly string[] = ['query', 'delete'];

/** A receiver whose name ends in `backend` or `Backend`. */
const BACKEND_RECEIVER = /[bB]ackend$/;

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
}

/** The 1-based lines of `text` holding a node `matches` accepts, each line once, in order. */
function linesWhere(
  text: string,
  matches: (node: ts.Node, file: ts.SourceFile) => boolean,
): number[] {
  const file = parse(text);
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (matches(node, file)) {
      lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}

/** The text of a string literal or of one piece of a template, or `undefined` for any other node. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return undefined;
}

/** The name an object literal gives one of its properties, or `undefined` for any other node. */
function assignedName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return undefined;
  const { name } = node;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * Lines of `text` that compose a key or name a key attribute: a string, or a
 * piece of a template, holding `PK` or `SK` as a word, or an object property
 * named `PK` or `SK`. Reading `row.PK` and declaring `PK: string` in a type
 * are not composing one.
 */
export function keySchemaWrites(text: string): number[] {
  return linesWhere(text, (node) => {
    const literal = literalText(node);
    const name = assignedName(node);
    return (
      (literal !== undefined && KEY_ATTRIBUTE_WORD.test(literal)) || name === 'PK' || name === 'SK'
    );
  });
}

/**
 * Lines of `text` that touch `messageCount`: the string `'messageCount'`, a
 * property access `.messageCount`, or an object property named
 * `messageCount`. A sentence that mentions it and a type that declares it are
 * not touching it.
 */
export function messageCountUses(text: string): number[] {
  return linesWhere(text, (node) => {
    if (ts.isStringLiteral(node)) return node.text === 'messageCount';
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'messageCount';
    return assignedName(node) === 'messageCount';
  });
}

/**
 * Lines of `text` that call a `VectorBackend`: a call of `upsert` or
 * `listKeys` on anything, or of `query` or `delete` on a receiver named like a
 * backend. The DynamoDB client's `query` and `delete` are held under other
 * names, and a false match surfaces as a call to move or to explain.
 */
export function vectorBackendCalls(text: string): number[] {
  return linesWhere(text, (node, file) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const method = node.expression.name.text;
    if (BACKEND_ONLY_METHODS.includes(method)) return true;
    return (
      SHARED_METHODS.includes(method) &&
      BACKEND_RECEIVER.test(node.expression.expression.getText(file))
    );
  });
}
