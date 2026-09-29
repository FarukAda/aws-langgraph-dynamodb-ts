# 29. Publish both an ES-module and a CommonJS build

## Status

Accepted.

## Context

The package shipped one build, CommonJS, and its `exports` map sent both the
`import` and the `require` condition to it. Its peers ship both:
`@langchain/core` and `@langchain/langgraph-checkpoint` each map `import` to an
ES-module build and `require` to a CommonJS one. An application written as ES
modules therefore loaded this package's CommonJS build, which `require`d the
CommonJS copies of those peers, beside the ES-module copies the application's
own `import`s loaded: two instances of each peer in one process.

Node's documentation calls this the dual package hazard: the instance `require`
returns is not the same as the one `import` returns, so "an `instanceof`
comparison of instances created by the two versions returns `false`", and
state added to one copy is missing from the other
(https://github.com/nodejs/package-examples/blob/main/guide/07-dual-packages/README.md,
the chapter Node's own `packages` documentation now points to). Here it meant a
`DynamoDBSaver` an ES-module application constructed was not an instance of
the `BaseCheckpointSaver` that application imported, and every peer module was
loaded, and held its state, twice.

The sibling package `@farukada/aws-langchain-s3-vector-ts` faced the same
question and made the same decision, in its own record 2.

## Decision

Both builds are compiled from the one source tree and published behind the
`import` and `require` conditions, each with its own `types`: `dist/esm` for
`import` and `dist/cjs` for `require`. The package root is `"type": "module"`,
and `dist/cjs` carries a `package.json` declaring `"type": "commonjs"`, which is
what makes Node and TypeScript read that subtree as CommonJS. The sources import
each other by their emitted `.js` names, which the ES-module build requires.

The published shape is checked rather than assumed. `pack:check` requires both
trees and the marker and runs `publint` and `arethetypeswrong` on its default
profile, from CommonJS, from ES modules and from a bundler. The package smoke
installs the packed tarball into a clean project and asserts, through `import`
and through `require` in turn, that each resolves its own tree, that a saver is
an instance of the `BaseCheckpointSaver` the same module system imports, that a
missing optional S3 peer is still reported as `VALIDATION` naming `s3` — which
the CommonJS build reaches through `require` rather than `import()` — and that
an error one copy raises is recognised by the other copy's
`isDynamoDBLangGraphError`, whose brand is a symbol registered by name. A
strict consumer is type-checked against each declaration tree.

## Consequences

Positive. An ES-module application loads one copy of each peer, and a class
this package extends is the class the application imports. A CommonJS
application sees no change.

Negative. There are two trees to build and ship, and an `exports` map that the
repository's own TypeScript program cannot validate, since it resolves the
sources rather than the tarball; only the packed checks above can. A default
import no longer resolves to the package's namespace, so a caller uses named
imports. The shipped JavaScript carries no comments, to keep the tarball from
doubling; the declarations keep their documentation.

Neutral. The source stays single: the CommonJS tree is a compilation target,
not a parallel implementation, and an error from either copy is still
recognised by the other's guard.
