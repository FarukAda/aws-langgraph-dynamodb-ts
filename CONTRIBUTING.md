# Contributing to aws-langgraph-dynamodb-ts

Thank you for helping. This guide is the operational one; the [README](README.md) explains the library and [docs/STABILITY.md](docs/STABILITY.md) what a release may change.

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

- a `src` file is at most 150 lines; a test file at most 400;
- comments are JSDoc only (`/** ... */`) — no `//` comments in `src`;
- no `any`, no `unknown`, no `instanceof` in `src` (errors are detected by brand and `code`);
- no re-exports outside `src/index.ts`, no import cycles, no dead `ErrorCode` member;
- every `info`/`warn`/`error` log event is documented in the README table, and the README IAM policy lists exactly the DynamoDB and S3 actions the code uses;
- the public export set and the adapter method signatures are pinned in `test/types/public-surface.test.ts` — changing them is a deliberate, documented act;
- `createClient` / `createS3Client` are `@internal` test seams and stay out of the shipped declarations.

Write the failing test first, then the code. A change that touches behaviour needs a unit test; a change that touches DynamoDB semantics also needs an integration or conformance test.

## Test tiers

| Tier | Command | Needs |
| --- | --- | --- |
| Unit, static, type, property | `npm test` | nothing |
| Integration and contract | `npm run test:integration:up && npm run test:integration` | Docker (DynamoDB Local) |
| Conformance (LangGraph contract, LangChain's validation suite) | `npm run test:conformance` | Docker |
| Package smoke | `npm run test:package-smoke` | network (`npm pack` + install into a temp project) |
| Real AWS | `AWS_REGION=eu-central-1 npm run test:aws` | AWS credentials |

CI runs every tier except the real-AWS one on each push and pull request; the real-AWS tier runs nightly through OIDC and can be dispatched by a maintainer.

### Real-AWS tests

A real-AWS test creates its own resources and tears them down in `afterAll` (use `test/aws/helpers/teardown.ts`, which finishes every step before rethrowing). Resource names must match `aws-langgraph-<suite>test-<uuid>` — the nightly role is scoped to `aws-langgraph-*test-*` and nothing else — and a test must never assume a region, a table or a bucket exists. A Bedrock-backed test probes the model first and skips with a reason when the account has not enabled it.

## Toolchain

Two TypeScript versions are installed on purpose: the `typescript` alias resolves to TypeScript 6 and drives ts-jest, ESLint and TypeDoc; `@typescript/native` (TypeScript 7) provides `tsc` and builds `dist` and the shipped declarations. `npm run typecheck` checks `src` with the compiler that emits; `npm run typecheck:all` checks the whole program including tests and configs. Linting is ESLint with Prettier; run `npm run lint:fix` before committing.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(store): ...`, `feat(history): ...`, `docs(readme): ...`, `test(integration): ...`). The body says why, not what: which behaviour was wrong, how a user hit it, why this fix and not another. One concern per commit.

A pull request follows the template: what, why, how, how it was tested, breaking changes. It needs a CHANGELOG entry under `[Unreleased]` for anything a user can observe, a README update when documented behaviour changes, and regenerated `docs/api` (`npm run docs`) when public JSDoc changes.

## Releases

Maintainers release from `main`: bump the version, move the `[Unreleased]` entry under the new version, tag `v<version>` and push the tag; the release workflow publishes with provenance. A prerelease tag publishes under the `next` dist-tag. What each release type may change is defined in [docs/STABILITY.md](docs/STABILITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
