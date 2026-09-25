# Contributing to aws-langgraph-dynamodb-ts

Thank you for helping. This guide is the operational one; the [README](README.md) explains the library, and its [*Versioning and compatibility*](README.md#versioning-and-compatibility) section says what a release may change. [`docs/coding-guidelines.md`](docs/coding-guidelines.md) is the standard the source itself is held to.

## Setup

```bash
git clone https://github.com/FarukAda/aws-langgraph-dynamodb-ts.git
cd aws-langgraph-dynamodb-ts
npm ci                 # Node 22, 24 or 26
npm run lint && npm run typecheck && npm run typecheck:all && npm test
```

`npm test` runs the unit tier: every test under `test/unit`, the static guards under `test/static`, the type locks under `test/types` and the property tests under `test/property`, with 100 % coverage enforced on branches, functions, lines and statements. It must stay green and at 100 % for every commit.

## The rules the guards enforce

The static guards fail the build rather than rely on review:

- file length and function complexity are not capped: a module is as large as the one decision it hides (`docs/decisions/0017-…`);
- a `/** ... */` block in `src` is interface documentation — the module's header, or the documentation of the declaration directly under it — and every other comment is a `//` line inside code; no `/* */` block and no `eslint-disable` or `@ts-` directive anywhere (`test/static/comment-kinds.test.ts`, decision record 23);
- every module in `src`, `src/index.ts` included, opens with a `/** */` header whose first paragraph — the second in `src/index.ts`, after the package's name — begins `Hides` and states the one decision the module hides, in at least 160 characters, followed by a blank line (`test/static/module-headers.test.ts`, decision record 22);
- no `any` and no `instanceof` in `src` (errors are detected by brand and `code`); no `unknown` either, except as the declared type of a parameter of a `parse*` function in one of the parser modules listed in `eslint.config.ts` — the one place a value is honestly not yet known to be anything (decision record 21);
- caller input is parsed once, at the boundary, into a branded type declared in a parser module and built by exactly one `parse*` function there; code downstream asks for the brand and does not check the value again. A test builds such a value through the parser, never with a cast. A function that returns the checked value is a `parse*` — a stored row's parser, which answers `undefined` for a row that is not this adapter's, included; one that returns nothing is an `assert*`; nothing is named `validate*`, `narrow*`, `require*`, `check*` or `checked*` (`test/static/check-names.test.ts`, decision records 21 and 24);
- one term per concept in every module-level name in `src`: a DynamoDB row is a `row`; `item` names the LangGraph store's `Item` and appears only under `src/store/`; `record` is never a noun; `backend` is the store's vector backend and, outside `src/store/`, appears only as `vector backend`; a deprecated alias keeps its old name until it is removed (`test/static/domain-terms.test.ts`, decision record 24);
- no re-exports outside `src/index.ts`, no import cycles, no dead `ErrorCode` member;
- no module imports from a layer above its own or from another feature; the layer table is `test/static/guards/layers.ts` (`test/static/layer-direction.test.ts`);
- a key is composed, and a key attribute named, only in `src/shared/dynamodb/table-schema.ts` and the three `src/<feature>/internal/rows.ts`; `messageCount` is read or written only in `src/history/internal/session.ts`; a `VectorBackend` is called only from `src/store/internal/vector-index.ts`; a paged read is resumed (`ExclusiveStartKey`) only by `src/shared/dynamodb/paginate.ts`, the recency index's per-shard cursors and the backfill's operator cursor (`test/static/owners.test.ts`, decision record 22);
- errors are recognised by code (`test/static/error-recognition.test.ts`);
- every AWS error name is declared by the SDK or documented (`test/static/aws-error-names.test.ts`);
- the removed class names appear nowhere a reader would act on them (`test/static/retired-error-names.test.ts`);
- every `ErrorCode` is in the README's table (`test/static/error-codes.test.ts`);
- every `info`/`warn`/`error` log event is documented in the README table, and the README IAM policy lists exactly the DynamoDB and S3 actions the code uses;
- the public export set and the adapter method signatures are pinned in `test/types/public-surface.test.ts` — changing them is a deliberate, documented act;
- `createClient` / `createS3Client` are `@internal` test seams and stay out of the shipped declarations;
- the generated API reference names no internal function — a page quotes only names some page documents, or an error field — and no page but the package page opens a paragraph with `Hides`, which would mean a module header had become a public name's documentation (`test/static/public-docs.test.ts`);
- a comment in `src` says why the code is as it is, not what it once did: `used to`, `until now`, `previously` and `formerly` are refused in `src` comments, because that history is in `CHANGELOG.md` and the commits (`test/static/history-prose.test.ts`);
- every non-private method of a class `src/index.ts` exports, and every function it exports, that is `async`, declares a return type beginning `Promise`, `PromiseLike`, `AsyncGenerator`, `AsyncIterable` or `AsyncIterableIterator`, or declares no return type at all has a body of exactly one `return guardPublic(…)` or `return guardPublicIterable(…)`, imported from `src/shared/errors/boundary.ts`, so only a library error ever rejects out of a public method or function; a function held in a class field or an exported variable, and a getter declaring such a return type, are held to the same rule. The check reads the return type as written, so one given through a type alias of a promise is not recognised, and it counts an exported variable as a function only when an arrow function or function expression is written in place, so a variable holding a class expression or a call's result, such as a wrapped function, is not checked. The public set is derived from `src/index.ts`, not kept by hand: every value it exports must be re-exported by name from the module that declares it, or declared in `src/index.ts` itself, and a form that cannot be resolved that way — a local `export { X }`, any default export, `export *`, or a name its module re-exports rather than declares — fails the guard instead of being skipped. The derived set must include the three adapters, `DynamoDBSessionChatMessageHistory`, `DynamoDBFactory` and `backfillRecencyIndex`, so a derivation that finds nothing fails too (`test/static/guarded-methods.test.ts`, `test/static/public-declarations.test.ts`);
- no `.ts` file in `src` or `test`, no `.mjs` file in `test` or directly in `scripts` or `examples`, and no hand-edited file — a `.md`, `.json`, `.yml`, `.yaml` or `*.config.ts` file directly in the repository root, except `package-lock.json`, which npm writes, or any file under `.github` but an image, PDF or archive — refers to the planning process — a numbered ruling, a plan task id or numbered plan task, a review-round label, a reference to a plan's brief, a design-decision id in a comment, or an audit finding id — a short letter prefix and a number, alone, in a parenthesised list, or plain in text — because a reader has no way to resolve it; the claim ids of `docs/evidence` (`E-14`) and the README's divergence ids (`V-26`) resolve and are allowed, and the generated `docs/api` is not scanned, since it is rebuilt from the `src` comments (`test/static/plan-references.test.ts`);
- those same files, and the surface baseline, hold no raw control character — a C0 control other than tab, LF and CR, DEL, a C1 control, an unpaired surrogate, or a byte-order mark anywhere but the first character — because such a character is invisible to readers, diffs and review; write one a test needs as an escape sequence (`test/static/control-characters.test.ts`).

Write the failing test first, then the code. A change that touches behaviour needs a unit test; a change that touches DynamoDB semantics also needs an integration or conformance test.

## Test tiers

| Tier | Command | Needs |
| --- | --- | --- |
| Unit, static, type, property | `npm test` | nothing |
| Surface baseline | `npm run build && npm run test:surface` | a current `dist` |
| Integration and contract | `npm run test:integration:up && npm run test:integration` | Docker (DynamoDB Local) |
| Conformance (LangGraph contract, LangChain's validation suite) | `npm run test:conformance` | Docker |
| Package smoke | `npm run test:package-smoke` | network (`npm pack` + install into a temp project) |
| Real AWS | `AWS_REGION=eu-central-1 npm run test:aws` | AWS credentials |

CI runs the unit, integration, conformance, surface and package-smoke tiers on each push and pull request. The surface baseline runs beside the package smoke test, on one platform: it is a snapshot, and comparing a snapshot across nine matrix legs is nine chances to disagree about nothing. Run it locally as well after any change to what the public API accepts or rejects, and regenerate with `npm run test:surface:update` only after reading the diff it printed. Two ratchets in `test/surface/surface.test.mjs` sit beside the baseline: `EXPECTED_BARE` caps the cases where an error that is not this library's escapes, and `EXPECTED_UPSTREAM` the cases that end in a code reporting a failure outside this library (`RETRY_EXHAUSTED`, `THROTTLED`, `SERVICE_UNAVAILABLE`, `CONTENTION`, `ACCESS_DENIED`, `NOT_FOUND`, `AWS_REJECTED`, `AWS_REQUEST_FAILED`, `UNEXPECTED_ERROR`). Both may only go down — lower the constant in the commit that fixes a case, never raise it — and `EXPECTED_UPSTREAM` is 0: no case the tier runs ends in one, so none reports a caller's mistake as an AWS failure. One tier runs only on release tags: the real-AWS tier, described below.

### Real-AWS tests

The real-AWS tier runs on every release tag, in `.github/workflows/integration-live.yml`, with the OIDC role named by the repository variable or secret `AWS_TEST_ROLE_ARN`, scoped to `aws-langgraph-*test-*` tables and buckets, in the region the repository variable or secret `AWS_TEST_REGION` names, and gates publishing: the release workflow waits for its `live-aws integration` check and refuses to publish unless it succeeded; after re-running a failed live run green, re-run the release workflow too ([decision record 18](docs/decisions/0018-run-the-live-aws-tier-on-release-tags-as-a-publish-gate.md)). It is deliberately not scheduled, because one of its suites calls Bedrock. Run it locally against your own credentials with `AWS_REGION=eu-central-1 npm run test:aws`; every suite refuses to start without `AWS_REGION` (or `AWS_DEFAULT_REGION`) rather than guess a region.

A real-AWS test creates its own resources and tears them down in `afterAll` (use `test/aws/helpers/teardown.ts`, which finishes every step before rethrowing). Resource names must match `aws-langgraph-<suite>test-<uuid>` — the test role is scoped to `aws-langgraph-*test-*` and nothing else — and a test must never assume a region, a table or a bucket exists. A Bedrock-backed test probes the model first and skips with a reason when the account has not enabled it.

## Toolchain

Two TypeScript versions are installed on purpose: the `typescript` alias resolves to TypeScript 6 and drives ts-jest, ESLint and TypeDoc; `@typescript/native` (TypeScript 7) provides `tsc` and builds `dist` and the shipped declarations. `npm run typecheck` checks `src` with the compiler that emits; `npm run typecheck:all` checks the whole program including tests and configs. Linting is ESLint with Prettier; run `npm run lint:fix` before committing.

Three stricter compiler flags were evaluated for the build and deliberately not enabled: `verbatimModuleSyntax` (incompatible with the CommonJS build, which would need `import = require` syntax everywhere), `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (39 and 56 sites whose guards would be unreachable branches under the 100 % branch gate). `package.json` carries no `overrides` block: the one it used to hold pinned `uuid`, which no longer appears in the lock file at all. `npm run pack:check` verifies the tarball listing, `publint` and `@arethetypeswrong/cli` before a release.

## Where behaviour comes from

Every behaviour this package claims is specified against a primary source and cited where it is implemented: the AWS documentation for DynamoDB and S3, the peer packages' own published source at the version this package targets (`@langchain/core`, `@langchain/langgraph-checkpoint`), or a recorded live probe under [`docs/evidence/README.md`](docs/evidence/README.md), paired with a named live test that fails the moment the service changes its answer ([decision record 16](docs/decisions/0016-specify-behaviour-against-primary-sources-only.md)).

What another implementation of the same problem does is never a source. A change argued as "the other client does it this way" is asked for the underlying reason instead; if there is one, that reason is the citation, and if there is not, the behaviour does not change. `MemorySaver` and `InMemoryStore` look like an exception and are not one: they are `@langchain/langgraph-checkpoint`'s and `@langchain/core`'s own published source for what the interfaces this package implements must do, which is why they are treated as the behavioural oracle ([decision record 9](docs/decisions/0009-treat-the-in-memory-reference-implementations-as-the-oracle.md)), and every deliberate departure from them is listed in the README's [*Differences from the reference implementations*](README.md#differences-from-the-reference-implementations) table.

A claim about behaviour AWS leaves undocumented needs both parts before a pull request can cite it: a probe recorded under `docs/evidence`, and a live test in `test/aws` guarding the same claim. A citation to documentation that turns out to be silent on the point is not evidence, and neither is coverage against DynamoDB Local alone — see [`docs/evidence/README.md`](docs/evidence/README.md) for why both are required.

## Decision records

Write a record when a decision is expensive to reverse — one that shapes the on-disk layout, the public API, the error taxonomy or what the build enforces, where undoing it later means a breaking change or redoing real work. A bug fix, a naming choice, or anything a later change can undo for free does not need one.

Each record has five sections — title, context, decision, status, consequences — in full sentences, addressed to a future developer wondering why something is the way it is: state the context in value-neutral language, including the technical and project forces at play; state the decision in the active voice; and list the consequences that are positive, negative and neutral, the negative ones included.

Records are numbered sequentially under `docs/decisions/`, and a number is never reused. A decision that is later reversed keeps its record, marked superseded and pointing at the one that replaced it, because the reasoning that led to it is what explains why the replacement was needed. See [`docs/decisions/README.md`](docs/decisions/README.md) for the full index.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(store): ...`, `feat(history): ...`, `docs(readme): ...`, `test(integration): ...`). The body says why, not what: which behaviour was wrong, how a user hit it, why this fix and not another. One concern per commit.

A pull request follows the template: what, why, how, how it was tested, breaking changes. It needs a CHANGELOG entry under `[Unreleased]` for anything a user can observe, a README update when documented behaviour changes, and regenerated `docs/api` (`npm run docs`) when public JSDoc changes.

Review a change in this order: design first, then functionality, complexity, tests, naming, comments, style and consistency, and documentation last — a design objection raised after the naming and style have been debated wastes that debate. Send a large reformatting as its own pull request, never folded into a functional one, so a reviewer can tell what changed from what merely moved. And say what was done well, not only what needs to change.

## Releases

Maintainers release from `main`: bump the version, move the `[Unreleased]` entry under the new version, tag `v<version>` and push the tag. The release workflow waits for every check in `scripts/required-checks.json` to succeed on the tagged commit, the live-AWS tier among them, re-runs the gates and packs the tarball in a job that cannot publish, then publishes exactly that tarball with provenance from a job that installs nothing. The GitHub release body is the version's CHANGELOG section, so the heading must read `## [<version>]` before tagging. A prerelease tag publishes under the `next` dist-tag. What each release type may change is defined in the README's [*Versioning and compatibility*](README.md#versioning-and-compatibility) section.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
