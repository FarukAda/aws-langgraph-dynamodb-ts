# Contributing to aws-langgraph-dynamodb-ts

Thank you for helping. This guide is the operational one; the [README](README.md) explains the library, and its [*Versioning and compatibility*](README.md#versioning-and-compatibility) section says what a release may change.

## Setup

```bash
git clone https://github.com/FarukAda/aws-langgraph-dynamodb-ts.git
cd aws-langgraph-dynamodb-ts
npm ci                 # Node 22 or 24
npm run lint && npm run typecheck && npm run typecheck:all && npm test
```

`npm test` runs the unit tier: every test under `test/unit`, the static guards under `test/static`, the type locks under `test/types` and the property tests under `test/property`, with 100 % coverage enforced on branches, functions, lines and statements. It must stay green and at 100 % for every commit.

## The rules the guards enforce

The static guards fail the build rather than rely on review:

- file length and function complexity are not capped: a module is as large as the one decision it hides (`docs/decisions/0017-…`);
- comments are JSDoc only (`/** ... */`) — no `//` comments in `src`;
- no `any`, no `unknown`, no `instanceof` in `src` (errors are detected by brand and `code`);
- no re-exports outside `src/index.ts`, no import cycles, no dead `ErrorCode` member;
- every `info`/`warn`/`error` log event is documented in the README table, and the README IAM policy lists exactly the DynamoDB and S3 actions the code uses;
- the public export set and the adapter method signatures are pinned in `test/types/public-surface.test.ts` — changing them is a deliberate, documented act;
- `createClient` / `createS3Client` are `@internal` test seams and stay out of the shipped declarations;
- every non-private method of a class `src/index.ts` exports, and every function it exports, that is `async`, declares a return type beginning `Promise`, `PromiseLike`, `AsyncGenerator`, `AsyncIterable` or `AsyncIterableIterator`, or declares no return type at all has a body of exactly one `return guardPublic(…)` or `return guardPublicIterable(…)`, imported from `src/shared/errors/boundary.ts`, so only a library error ever rejects out of a public method or function; a function held in a class field or an exported variable, and a getter declaring such a return type, are held to the same rule. The check reads the return type as written, so one given through a type alias of a promise is not recognised, and it counts an exported variable as a function only when an arrow function or function expression is written in place, so a variable holding a class expression or a call's result, such as a wrapped function, is not checked. The public set is derived from `src/index.ts`, not kept by hand: every value it exports must be re-exported by name from the module that declares it, or declared in `src/index.ts` itself, and a form that cannot be resolved that way — a local `export { X }`, any default export, `export *`, or a name its module re-exports rather than declares — fails the guard instead of being skipped. The derived set must include the three adapters, `DynamoDBSessionChatMessageHistory`, `DynamoDBFactory` and `backfillRecencyIndex`, so a derivation that finds nothing fails too (`test/static/guarded-methods.test.ts`, `test/static/public-declarations.test.ts`);
- no `.ts` file in `src` or `test`, no `.mjs` file in `test` or directly in `scripts` or `examples`, and no hand-edited file — a `.md`, `.json`, `.yml`, `.yaml` or `*.config.ts` file directly in the repository root, except `package-lock.json`, which npm writes, or any file under `.github` but an image, PDF or archive — refers to the planning process — a numbered ruling, a plan task id or numbered plan task, a review-round label, a reference to a plan's brief, or a design-decision id in a comment — because a reader has no way to resolve it; audit finding ids are allowed, and the generated `docs/api` is not scanned, since it is rebuilt from the `src` comments (`test/static/plan-references.test.ts`);
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

CI runs the unit, integration, conformance, surface and package-smoke tiers on each push and pull request. The surface baseline runs beside the package smoke test, on one platform: it is a snapshot, and comparing a snapshot across six matrix legs is six chances to disagree about nothing. Run it locally as well after any change to what the public API accepts or rejects, and regenerate with `npm run test:surface:update` only after reading the diff it printed. Two ratchets in `test/surface/surface.test.mjs` sit beside the baseline: `EXPECTED_BARE` caps the cases where an error that is not this library's escapes, and `EXPECTED_UPSTREAM` the cases that end in `UpstreamError` or `RetryExhaustedError`. Both may only go down — lower the constant in the commit that fixes a case, never raise it — and `EXPECTED_UPSTREAM` is 0: no case the tier runs ends in either, so none reports a caller's mistake as an AWS failure. One tier runs only on release tags: the real-AWS tier, described below.

### Real-AWS tests

The real-AWS tier runs on every release tag, in `.github/workflows/integration-live.yml`, with the OIDC role named by the repository variable or secret `AWS_TEST_ROLE_ARN`, scoped to `aws-langgraph-*test-*` tables and buckets, in the region the repository variable or secret `AWS_TEST_REGION` names, and gates publishing: the release workflow waits for its `live-aws integration` check and refuses to publish unless it succeeded; after re-running a failed live run green, re-run the release workflow too ([decision record 18](docs/decisions/0018-run-the-live-aws-tier-on-release-tags-as-a-publish-gate.md)). It is deliberately not scheduled, because one of its suites calls Bedrock. Run it locally against your own credentials with `AWS_REGION=eu-central-1 npm run test:aws`; every suite refuses to start without `AWS_REGION` (or `AWS_DEFAULT_REGION`) rather than guess a region.

A real-AWS test creates its own resources and tears them down in `afterAll` (use `test/aws/helpers/teardown.ts`, which finishes every step before rethrowing). Resource names must match `aws-langgraph-<suite>test-<uuid>` — the test role is scoped to `aws-langgraph-*test-*` and nothing else — and a test must never assume a region, a table or a bucket exists. A Bedrock-backed test probes the model first and skips with a reason when the account has not enabled it.

## Toolchain

Two TypeScript versions are installed on purpose: the `typescript` alias resolves to TypeScript 6 and drives ts-jest, ESLint and TypeDoc; `@typescript/native` (TypeScript 7) provides `tsc` and builds `dist` and the shipped declarations. `npm run typecheck` checks `src` with the compiler that emits; `npm run typecheck:all` checks the whole program including tests and configs. Linting is ESLint with Prettier; run `npm run lint:fix` before committing.

Three stricter compiler flags were evaluated for the build and deliberately not enabled: `verbatimModuleSyntax` (incompatible with the CommonJS build, which would need `import = require` syntax everywhere), `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (39 and 56 sites whose guards would be unreachable branches under the 100 % branch gate). `package.json` carries no `overrides` block: the one it used to hold pinned `uuid`, which no longer appears in the lock file at all. `npm run pack:check` verifies the tarball listing, `publint` and `@arethetypeswrong/cli` before a release.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(store): ...`, `feat(history): ...`, `docs(readme): ...`, `test(integration): ...`). The body says why, not what: which behaviour was wrong, how a user hit it, why this fix and not another. One concern per commit.

A pull request follows the template: what, why, how, how it was tested, breaking changes. It needs a CHANGELOG entry under `[Unreleased]` for anything a user can observe, a README update when documented behaviour changes, and regenerated `docs/api` (`npm run docs`) when public JSDoc changes.

## Releases

Maintainers release from `main`: bump the version, move the `[Unreleased]` entry under the new version, tag `v<version>` and push the tag. The release workflow waits for every check in `scripts/required-checks.json` to succeed on the tagged commit, the live-AWS tier among them, re-runs the gates and packs the tarball in a job that cannot publish, then publishes exactly that tarball with provenance from a job that installs nothing. The GitHub release body is the version's CHANGELOG section, so the heading must read `## [<version>]` before tagging. A prerelease tag publishes under the `next` dist-tag. What each release type may change is defined in the README's [*Versioning and compatibility*](README.md#versioning-and-compatibility) section.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
