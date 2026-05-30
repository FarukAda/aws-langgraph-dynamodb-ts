# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status — HARDENED

The rework is complete. The current `src/` is the reworked code: ~90 single-purpose files (largest 136 lines), 100% test coverage (branches/functions/lines/statements) with real assertions, and a layered test strategy (unit + static guards + property + contract + conformance + integration on DynamoDB Local/LocalStack + real-AWS fault injection). `typecheck`, `lint`, and the full test suite are clean, and the real-AWS suite (`npm run test:aws`) passes against a live account. Treat the existing architecture, file layout, and patterns as correct precedent and follow them.

The **Coding Rules** below remain the binding standard for every change and are machine-enforced by the `test/static/` guards (file length, JSDoc-only comments, no `any`/`unknown`, no barrels, error-code coverage). When code conflicts with a rule, the rule wins; fix the code.

## What this is (the product goal)

`@farukada/aws-langgraph-dynamodb-ts` — a DynamoDB persistence layer for LangGraph (TypeScript, ESM, Node ≥22). It provides three LangGraph adapters plus a factory:

- **`DynamoDBSaver`** — `extends BaseCheckpointSaver`. Checkpoint + pending-writes persistence.
- **`DynamoDBStore`** — `extends BaseStore`. Long-term memory with optional semantic search via a LangChain `EmbeddingsInterface`.
- **`DynamoDBChatMessageHistory`** — multi-session chat history, with a single-session adapter for LangChain's `RunnableWithMessageHistory`.
- **`DynamoDBFactory`** — convenience constructors, including `createAll` (one shared client + a `destroy()`).

Optional capabilities the product must support: gzip compression, S3 offloading of payloads over DynamoDB's 400 KB item limit (with `@aws-sdk/client-s3` as an **optional** peer dependency), and TTL-based expiry. The single public entry point is `src/index.ts`.

## Coding Rules (binding)

These are the standard for every change. No exceptions without explicit user sign-off.

### Naming
- Names must describe what the thing does. No unclear, cryptic, or misleading names.
- Fixed casing rules, followed consistently across the repo:
  - Files and directories: **kebab-case** (e.g. `client-factory.ts`, `chat-history/`).
  - Types, interfaces, enums, classes: **PascalCase**.
  - Variables and functions: **camelCase**.
  - Constants: **SCREAMING_SNAKE_CASE**.
- No magic numbers or strings — use named constants.

### Comments
- The only comments allowed are JSDoc. No inline `//` or `/* */` narrative comments.

### Exports
- No re-exports, **except** for the package's public exports (the `src/index.ts` entry point).

### Files & separation of concern
- Max **150 lines** per file.
- One concern per file — enforce separation of concern.
- Single responsibility per function, with a bounded function length.
- No circular dependencies between modules.

### Code duplication
- No duplicated code. Extract and reuse shared code.

### Project structure
- Structure must make it easy to find things. Naming and divisions must be deliberate and well thought out.

### Dead code
- No dead or unreachable code.

### Simplicity
- No overengineering. Don't build what isn't needed.
- Keep nesting shallow and functions simple: machine-enforced `max-depth ≤ 3` and cyclomatic `complexity ≤ 10` (ESLint). Prefer extracting a well-named helper over deepening a function; do not over-decompose to chase a lower number.

### Types
- No `any` or `unknown`.
- Model everything explicitly with interfaces, contracts, and enums. No loose or unexpected types.

### Error handling
- Errors are thrown, wrapped, and surfaced in one consistent, defined way. No silent failures.

### Testing
- 100% unit-test coverage.
- Tests assert real, expected outcomes — no tests written only to inflate coverage.
- Location and naming: `test/` mirrors the `src/` directory structure; each source file `src/<path>/<name>.ts` has its unit test at `test/<path>/<name>.test.ts`.

### Dev tooling
- No disabling or excluding dev tools — no commenting out the linter, no blanket ignore rules to make checks pass.

## Commands

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src + test
npm run lint:fix       # eslint --fix
npm test               # jest unit tests, collects coverage
npm test -- path/to/file.test.ts          # single file
npm test -- -t "name of the test"         # single test by name
```

Integration tests need Docker (DynamoDB Local on :8000 + LocalStack S3 on :4566):

```bash
npm run test:integration:up      # docker compose up -d
npm run test:integration         # runs test/integration/** (runInBand)
npm run test:integration:down    # docker compose down
```

The coverage target is **100%** (Testing rule above). `jest.config.ts` currently sets lower thresholds — raise them toward 100% as the rework progresses; do not lower them.

### Do NOT run
- **Stryker / mutation testing is forbidden** on this machine — it pegs the user's CPU (blocked via hook + deny rules).
- Ask before any other CPU/RAM-heavy command (`jscpd` full scan, `knip`, large `depcheck`); never run heavy commands in parallel.

## Conventions

- Prettier: single quotes, semicolons, `printWidth: 100`, `trailingComma: all`.
- Run `npm run lint` (and `typecheck`) before declaring work done.
- Commit messages: do **not** add a `Co-Authored-By: Claude` trailer on this project.