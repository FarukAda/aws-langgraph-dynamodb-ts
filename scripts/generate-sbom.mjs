/**
 * Write the two SBOMs a release needs, because `npm sbom` alone cannot
 * describe this package honestly.
 *
 * What a consumer installs with this package is its three runtime
 * `dependencies` (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`,
 * `@aws-sdk/util-dynamodb`) and its `peerDependencies` (`@langchain/core`,
 * `@langchain/langgraph-checkpoint`, and `@aws-sdk/client-s3` when S3 offload
 * is used). The peers are in this repo's tree only as development packages,
 * each a devDependency or a dependency of one, so `npm sbom --omit=dev` drops
 * every one of them, while the full tree lists them among some six hundred
 * build tools.
 *
 * So: two documents, each honest about what it is.
 *
 * 1. `sbom.build.cyclonedx.json` — npm's own output over the whole installed
 *    tree, unmodified. This is what built the tarball: the compiler, the test
 *    runner, the linter and everything under them. It is the document to audit
 *    a build against, and the runtime dependencies and the peers all appear in
 *    it at the versions the build resolved.
 *
 * 2. `sbom.runtime.cyclonedx.json` — what a consumer takes on by installing
 *    this package: this package, its runtime dependencies and the peers it
 *    requires. Derived from (1) by filtering, never hand-written, so every
 *    purl, hash, licence and external reference is npm's rather than this
 *    script's invention.
 *
 * The one fact (1) cannot carry into (2) is that a version in the tree is the
 * version *this build* resolved, not the version a consumer will get. Each
 * component therefore carries its declared range as a property, and the
 * document says so in `metadata.properties`, so the runtime SBOM cannot be read
 * as a claim about a consumer's lockfile.
 *
 * Usage: `node scripts/generate-sbom.mjs [outDir]` (default: the repo root).
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.';

/** npm exports its own config to child processes; none of it may steer this one. */
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')),
);

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * Every package a consumer's install takes on, with the range that promises
 * it and the property that records which kind of edge it is.
 */
const declared = [
  ...Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({
    name,
    range,
    property: 'npm:dependency:range',
  })),
  ...Object.entries(manifest.peerDependencies ?? {}).map(([name, range]) => ({
    name,
    range,
    property: 'npm:peerDependency:range',
    optional: manifest.peerDependenciesMeta?.[name]?.optional === true,
  })),
];
if (declared.length === 0) {
  throw new Error(
    'package.json declares no dependencies and no peerDependencies. This script exists to ' +
      'carry them into the runtime SBOM; with none declared, revisit whether it is still the ' +
      'right shape.',
  );
}

// No --omit: the point of the build document is that nothing is filtered, and
// it is also the only run in which the peers appear at all.
//
// --legacy-peer-deps, because `npm sbom` refuses a tree holding any invalid
// edge, and this one holds one that `npm ci` accepts: vite (under the
// LangGraph checkpoint-validation suite's vitest) declares an *optional* peer
// on `yaml@^2.4.2`, which resolves to the `yaml@1` that depcheck's cosmiconfig
// hoisted. The flag stops npm reading peer edges while it walks the tree, so
// every installed package is still listed and only peer relationships are
// missing from the dependency graph; a peer this package does not also list in
// devDependencies (`@langchain/core`) is then reported there as extraneous.
// The runtime document below takes its components' kind and scope from
// package.json, not from those edges.
const build = JSON.parse(
  execSync('npm sbom --sbom-format=cyclonedx --legacy-peer-deps', {
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString(),
);

const root = build.metadata?.component;
if (!root?.['bom-ref']) {
  throw new Error('npm sbom produced no root component; cannot derive the runtime SBOM from it.');
}

/** npm's properties about a package's place in this repository's tree. */
const TREE_POSITION = new Set(['cdx:npm:package:development', 'cdx:npm:package:extraneous']);

const components = declared.map(({ name, range, property, optional }) => {
  const component = build.components?.find((candidate) => candidate.name === name);
  if (!component) {
    throw new Error(
      `"${name}" is declared in package.json but absent from the installed tree, so the ` +
        'runtime SBOM would understate what a consumer needs. Run `npm ci` first.',
    );
  }
  return {
    ...component,
    // An optional peer is one a consumer installs only for the feature that
    // needs it (S3 offload, here); everything else is required.
    scope: optional ? 'optional' : 'required',
    properties: [
      // Where npm found the package in *this* tree — a devDependency, or
      // extraneous once peer edges are not read — says nothing about a
      // consumer's install, so it is not carried over.
      ...(component.properties ?? []).filter((entry) => !TREE_POSITION.has(entry.name)),
      // The tree's version is this build's resolution. The range is the promise.
      { name: property, value: range },
    ],
  };
});

const runtime = {
  bomFormat: build.bomFormat,
  specVersion: build.specVersion,
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: build.metadata.timestamp,
    lifecycles: [{ phase: 'build' }],
    tools: [
      ...(build.metadata.tools ?? []),
      { name: 'generate-sbom.mjs', vendor: 'this repository' },
    ],
    component: root,
    properties: [
      {
        name: 'sbom:scope',
        value:
          'What installing this package takes on at runtime: its dependencies, each carrying ' +
          'npm:dependency:range, and its peerDependencies, which the consumer installs and ' +
          'resolves themselves, each carrying npm:peerDependency:range. The range is the ' +
          'declared promise; the version beside it is the one this build happened to resolve, ' +
          'which is not a claim about any consumer lockfile. What each component depends on in ' +
          'turn is decided by the version a consumer resolves, so it is left unknown here ' +
          'rather than stated. For the toolchain that produced the tarball, see ' +
          'sbom.build.cyclonedx.json.',
      },
    ],
  },
  components,
  // The root, and nothing else. CycloneDX reads an entry with an empty
  // `dependsOn` as a statement — "this component has no dependencies" — and a
  // component missing from the graph as unknown. Each AWS SDK client depends on
  // a great deal, and on what depends on the version a consumer installs,
  // which this document cannot know; so it says nothing.
  dependencies: [{ ref: root['bom-ref'], dependsOn: components.map((entry) => entry['bom-ref']) }],
};

const write = (name, document) => {
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}
`);
  return path;
};

const buildPath = write('sbom.build.cyclonedx.json', build);
const runtimePath = write('sbom.runtime.cyclonedx.json', runtime);

console.log(`${buildPath}: ${build.components?.length ?? 0} components (full installed tree)`);
console.log(
  `${runtimePath}: ${components.length} components (${declared.map(({ name }) => name).join(', ')})`,
);
