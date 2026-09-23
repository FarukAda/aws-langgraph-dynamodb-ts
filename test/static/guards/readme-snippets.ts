import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

import { SRC_ROOT } from './source-files';

const REPO_ROOT = resolve(SRC_ROOT, '..');
const PACKAGE_NAME = '@farukada/aws-langgraph-dynamodb-ts';

/** Where the compiled snippet pretends to live; never written to disk. */
const SNIPPET_FILE = join(REPO_ROOT, 'readme-snippet.ts');

/**
 * What a snippet may use without declaring it. The README's examples call an
 * adapter they built earlier on the page; the compile supplies one of the
 * right type rather than the construction the example leaves out.
 */
const PRELUDE =
  `import type { DynamoDBStore as ReadmeStore } from '${PACKAGE_NAME}';\n` +
  'declare const store: ReadmeStore;\n';

/**
 * The first `typescript` block after the `## <heading>` line of `readme`, or
 * `undefined` when that section has none before the next `## ` heading.
 */
export function readmeSnippet(
  heading: string,
  readme: string = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'),
): string | undefined {
  const lines = readme.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) return undefined;
  const collected: string[] = [];
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    if (!inside && line.startsWith('## ')) return undefined;
    if (!inside && line === '```typescript') {
      inside = true;
    } else if (inside && line === '```') {
      return collected.join('\n');
    } else if (inside) {
      collected.push(line);
    }
  }
  return undefined;
}

/**
 * Compile `snippet` the way a consumer with `strict` on would, importing this
 * package by its published name (resolved to the source), and return every
 * diagnostic raised against the snippet as `TS<code>: <message>`.
 */
export function snippetDiagnostics(snippet: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    lib: ['lib.es2022.d.ts'],
    paths: { [PACKAGE_NAME]: [join(SRC_ROOT, 'index.ts')] },
  };
  const source = `${snippet}\n${PRELUDE}`;
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => (resolve(file) === SNIPPET_FILE ? source : readFile(file));
  host.fileExists = (file) => resolve(file) === SNIPPET_FILE || fileExists(file);
  host.getSourceFile = (file, language, ...rest) =>
    resolve(file) === SNIPPET_FILE
      ? ts.createSourceFile(file, source, language, true)
      : getSourceFile(file, language, ...rest);
  host.getCurrentDirectory = () => REPO_ROOT;
  const program = ts.createProgram([SNIPPET_FILE], options, host);
  const file = program.getSourceFile(SNIPPET_FILE);
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (diagnostic) =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}
