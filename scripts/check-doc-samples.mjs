/**
 * Type-check every TypeScript sample in the documentation a reader copies from.
 *
 * "The documentation" is exactly `DOCUMENTS` below, and within those files
 * exactly the ```` ```ts ```` and ```` ```typescript ```` fences. A `js`,
 * `bash`, `json` or `hcl` block is not checked, nothing under `docs/` is, and
 * `examples/*.mjs` is plain JavaScript run against the built package instead.
 *
 * `test/static/readme-snippets.test.ts` compiles one block, the error-handling
 * example, under `strict`. This compiles all of them, against `src/` rather
 * than a copy, so a documented call whose signature changed fails the build
 * instead of the reader. Samples are compiled as ES modules with bundler
 * resolution — the settings the static snippet guard uses — so top-level
 * `await` is legal in a sample; a CommonJS reader wraps it in a function.
 *
 * Free identifiers a sample assumes (`store`, `embeddings`, `model`, …) are
 * ambient globals of the right type, so a call is checked as strictly as in
 * the source while its setup is elided. A sample that declares its own
 * shadows them. A block that cannot compile here — pseudo-code, or a package
 * this one does not depend on — is marked in the document:
 *
 *     <!-- sample:skip why this block cannot compile -->
 *
 * The reason is required, and the number of skips is asserted, so silencing a
 * real breakage costs an edit that shows up in review.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './is-main.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, '.doc-samples');

/** The documents whose samples a reader is expected to be able to run. */
export const DOCUMENTS = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];

/**
 * Blocks legitimately un-compilable, and why:
 * 1. `README.md`, *Logging* — the pino adapter; pino is not a dependency.
 * 2. `README.md`, *Infrastructure setup* — the AWS CDK table; aws-cdk-lib is not one either.
 */
export const EXPECTED_SKIPS = 2;

/** A scan that finds fewer samples than this is broken, not clean. */
export const MINIMUM_SAMPLES = 15;

/**
 * How long the compiler gets before this script kills it and fails rather
 * than hang. A handful of generated files type-checking against `src/`
 * finishes in seconds; two minutes is headroom, not a budget anything here
 * is expected to use.
 */
const TSC_TIMEOUT_MS = 120_000;

const MINIMUM_REASON_LENGTH = 15;
const FENCE = /(?:<!--\s*sample:skip\s+([^>]*?)\s*-->\s*\r?\n)?```(?:ts|typescript)\r?\n([\s\S]*?)```/g;
const PACKAGE = '@farukada/aws-langgraph-dynamodb-ts';

const GLOBALS = `import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import type { Runnable } from '@langchain/core/runnables';
import type {
  DynamoDBChatMessageHistory,
  DynamoDBSaver,
  DynamoDBStore,
} from '${PACKAGE}';

declare global {
  // The context a sample assumes rather than repeats, each with the type the
  // real thing has: only the setup is elided, never the checking. \`embeddings\`
  // is the abstract class, not just \`EmbeddingsInterface\`: this package's
  // \`index.embeddings\` is upstream's \`IndexConfig['embeddings']\` verbatim
  // (src/store/types.ts), which pins the class (its \`caller\` property
  // included) rather than the structural interface — a plain object built
  // from \`EmbeddingsInterface\` alone fails that assignment.
  const store: DynamoDBStore;
  const saver: DynamoDBSaver;
  const history: DynamoDBChatMessageHistory;
  const embeddings: Embeddings;
  const model: BaseChatModel;
  const chain: Runnable;
  const controller: AbortController;
}

export {};
`;

const TSCONFIG = {
  extends: '../tsconfig.build.json',
  compilerOptions: {
    noEmit: true,
    rootDir: null,
    outDir: null,
    declaration: false,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    // A sample shows the call, not what the reader does with its result.
    noUnusedLocals: false,
    noUnusedParameters: false,
    paths: { [PACKAGE]: ['../src/index.ts'] },
  },
  include: ['*.ts'],
};

/**
 * Accepts: `documents`, a list of `{ name, text }`.
 *
 * Returns: `{ samples, skips, problems }` — each compilable fence as
 * `{ name, index, block }` (`index` counts every `ts`/`typescript` fence in
 * that document, skipped ones included), each skipped one as
 * `{ name, index, reason }`, and a message per skip whose reason is too short.
 */
export function collectSamples(documents) {
  const samples = [];
  const skips = [];
  const problems = [];
  for (const { name, text } of documents) {
    let index = 0;
    for (const [, reason, block] of text.matchAll(FENCE)) {
      const position = index++;
      if (reason === undefined) {
        samples.push({ name, index: position, block });
        continue;
      }
      if (reason.trim().length < MINIMUM_REASON_LENGTH) {
        problems.push(`${name} sample #${position}: sample:skip needs a reason, got "${reason}"`);
      }
      skips.push({ name, index: position, reason });
    }
  }
  return { samples, skips, problems };
}

/** The generated file a sample is compiled from, named for its document and position. */
export function sampleFileName(name, index) {
  return `${name.replace(/\W/g, '_')}_${index}.ts`;
}

function main() {
  const documents = DOCUMENTS.map((name) => ({
    name,
    text: readFileSync(join(ROOT, name), 'utf8'),
  }));
  const { samples, skips, problems } = collectSamples(documents);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  if (samples.length < MINIMUM_SAMPLES) {
    console.error(`Only ${samples.length} samples found (expected at least ${MINIMUM_SAMPLES}).`);
    return 1;
  }
  if (skips.length !== EXPECTED_SKIPS) {
    console.error(
      `${skips.length} samples are marked sample:skip, but ${EXPECTED_SKIPS} are expected. ` +
        'Skipping a sample is a deliberate change: update EXPECTED_SKIPS in this script.',
    );
    return 1;
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'globals.d.ts'), GLOBALS);
  writeFileSync(join(OUT_DIR, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  for (const { name, index, block } of samples) {
    // `export {}` makes the sample a module, where top-level `await` is legal.
    writeFileSync(join(OUT_DIR, sampleFileName(name, index)), `${block}\nexport {};\n`);
  }
  // Through Node rather than npx: a `.cmd` shim needs a shell on Windows.
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc6', import.meta.url));
  const result = spawnSync(process.execPath, [compiler, '-p', join(OUT_DIR, 'tsconfig.json')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TSC_TIMEOUT_MS,
  });
  if (result.error) {
    console.error(`Could not run the compiler: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(
      `The compiler did not finish within ${TSC_TIMEOUT_MS}ms and was killed (${result.signal}). ` +
        'Treat this as a hang, not a pass: investigate rather than raising the timeout.',
    );
    return 1;
  }
  if (result.status !== 0) {
    console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim());
    console.error(
      `\n${samples.length} documentation samples checked; each failing file is named for ` +
        'its document and the position of the block inside it.',
    );
    return 1;
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  console.log(`${samples.length} documentation samples type-check (${skips.length} skipped).`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
