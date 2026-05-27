# Test Suite Rewrite — Design

**Date:** 2026-05-28
**Status:** Approved (pending user review of this document)
**Author:** Brainstorming session with Claude
**Package:** `@farukada/aws-langgraph-dynamodb-ts`

## 1. Problem

The current test suite passes consistently while real bugs reach users. Inspection confirms the diagnosis: many tests assert only that DynamoDB was called (e.g. `expectDynamoDBCalled(mock, 1)` in `test/store/actions/put-operation.test.ts:37`), never that the right command class was used, never that the `Key` / `UpdateExpression` / `ExpressionAttributeNames` / `ExpressionAttributeValues` / `ConditionExpression` were correct. The suite is large but its signal is near zero. As a result:

- A production release with known bug classes is imminent (the immediate motivator).
- Refactors to action handlers can silently break payloads and still leave CI green.
- LangGraph contract drift, DynamoDB reserved-word collisions, S3-offload race paths, pagination edges, and optimistic-concurrency races are entirely untested.

This is the **one shot** to reset the suite before shipping. The redesign is aggressive: delete the existing tests wholesale (the rot is precedent-setting), rebuild on three explicit tiers, and add the gaps the current suite ignores.

## 2. Goals & Non-Goals

### Goals

1. Every bug class typical of a DynamoDB + LangGraph adapter is exercised by at least one test that would have caught the bug.
2. Tests fail loudly when behavior drifts — no silent passes, no `expect.any(...)` waving away assertions that could be exact.
3. Each test tier (unit, mutation, integration) owns the failure modes it is best suited to catch. No tier carries weight it can't bear.
4. Public API surface is locked: a rename or removal in `src/index.ts` fails CI.
5. The library demonstrably satisfies LangGraph's upstream interfaces (`BaseCheckpointSaver`, `BaseStore`) — not just its own self-test view of them.
6. CI is deterministic: tests pass three times in a row or they fail the gate.

### Non-Goals

- Replacing Jest or migrating to another framework.
- Reimplementing `src/`. The spec assumes current source is correct unless a new test surfaces a bug; bug-fix PRs are out of scope here.
- Performance benchmarks. Out of scope; the suite measures correctness, not throughput.
- 100% mutation score. Equivalent mutants exist; we target per-file thresholds (see §6).

## 3. Strategy — Hybrid by Tier

Three tiers with non-overlapping responsibilities.

### 3.1 Tier 1 — Unit tests (`test/unit/**`)

Fast, no I/O, run on every save. Layout mirrors `src/`.

**What they own:**

1. **Pure logic.** `compressor`, `retry`, `sleep`, `ttl`, `filter`, all `validation` modules, `update-expression-builder`, `optimistic-retry`, `deserialization`, `title-generator`, `session-adapter`, `batch-write`, `s3-offloader`, `s3-orphans`, `logger`. These files are the primary mutation-testing surface.
2. **Action handlers with strict command-shape assertions** (see §4). Every action in `store/`, `history/`, `checkpointer/` plus `factory.ts`.
3. **Error paths.** Each AWS error the code claims to handle (`ConditionalCheckFailedException`, `ProvisionedThroughputExceededException`, `ResourceNotFoundException`, throttling, `RequestLimitExceeded`) has a test that simulates the error and asserts the documented behavior (retry, throw, swallow). Each `try/catch` branch in `src/` is exercised.
4. **Boundary inputs.** Empty arrays, missing optional fields, reserved words (`ttl`, `data`, `value`, `key`, `name`, `status`, `type`), unicode/special chars in keys, namespace segments containing `#` or `/`, max-size payloads, zero/negative TTL.
5. **Public-surface smoke.** `test/unit/index.test.ts` imports *only* from `src/index.ts` and verifies the high-level happy paths still work. A consumer cannot use anything that this file doesn't import.

### 3.2 Tier 2 — Mutation tests (Stryker)

Already configured in the repo. Targeted at pure-logic files from Tier 1.1. Per-file thresholds in `stryker.conf` (see §6). A surviving mutant is a real test gap. Equivalent mutants are recorded with an inline comment justifying the exclusion.

### 3.3 Tier 3 — Integration tests (`test/integration/**`)

Run against DynamoDB Local + LocalStack via `docker compose`. Slow (seconds per test), so they own only what mocks cannot prove:

1. **Real DDB expression semantics.** The strings the action builders produce must actually be valid DynamoDB syntax (reserved-word bugs hide here).
2. **Conditional-write semantics.** `ConditionalCheckFailed` fires under the race we expect.
3. **Pagination & filter ordering.** `ExclusiveStartKey` round-trips; `FilterExpression`-after-`KeyCondition` ordering is correct; empty pages with `LastEvaluatedKey` still get followed (see §5.G).
4. **End-to-end user flows.** Checkpoint+resume, history append+read+clear, store put+search with embeddings, S3 offload+rehydrate, orphan cleanup.
5. **Concurrency.** Two real concurrent clients racing on `messageCount` optimistic lock — one wins, the other retries, final state consistent (see §5.H).
6. **TTL & key schema.** Tables created with the same schema the library expects in prod.

**Rule of thumb:** if a bug can pass a mock and fail against real DDB, the test lives in Tier 3.

### 3.4 Contract tier (`test/contract/**`)

Conformance tests for LangGraph's upstream interfaces (see §5.A). Run against the unit-mock client — they validate that we satisfy the *interface*, not that DDB behaves correctly.

### 3.5 Static tier (`test/static/**`)

Code-as-data checks. Currently: the reserved-words guard (§5.D).

### 3.6 Types tier (`test/types/**`)

`tsd` / `expectTypeOf` tests for `src/index.ts` exports (§5.B).

### 3.7 Package-smoke tier (`test/package-smoke/**`)

`npm pack` + install in temp dir + import + run a representative flow (§5.I). Runs on release branches and weekly.

## 4. Assertion Bar — What "Strict" Means

This is the technical heart of the rewrite. New rules:

1. **Full-shape DDB assertions.** For every DDB call, assert the exact command class *and* the full input.
   ```ts
   const calls = ddbDocMock.commandCalls(UpdateCommand);
   expect(calls).toHaveLength(1);
   expect(calls[0].args[0].input).toEqual({
     TableName: 'memory',
     Key: { user_id: 'user-123', namespace_key: 'ns#key1' },
     UpdateExpression:
       'SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)',
     ExpressionAttributeNames: { '#key': 'key', '#value': 'value' },
     ExpressionAttributeValues: {
       ':namespace': 'ns',
       ':key': 'key1',
       ':value': { data: 'value' },
       ':updatedAt': FROZEN_NOW,
       ':createdAt': FROZEN_NOW,
     },
   });
   ```
2. **Time is controlled.** `jest.useFakeTimers()` and a fixed `Date.now()` are the test-suite default. Timestamps in DDB inputs are pinned to constants, never `expect.any(Number)`. TTL math is provable: 30-day TTL at frozen `T` produces exactly `T/1000 + 30*86400`.
3. **Mocks reject unexpected calls.** The new `mockClient` setup throws on any command that isn't explicitly stubbed. A stray `QueryCommand` from `putOperationAction` fails the test loudly.
4. **Retry tests verify what was retried.** Number of attempts, exact backoff delays (with fake timers), and that the *same* command shape was sent each time.
5. **No snapshot tests for DDB inputs.** Explicit `.toEqual()` only — snapshots silently absorb regressions when developers update them.
6. **Round-trip tests for anything serialized.** `compressor`, `deserialization`, `s3-offloader` payload encoding, `optimistic-retry` cursor encoding — `decode(encode(x)) === x` over a property table covering empty / unicode / deeply nested / large binary.
7. **Table-driven property tests for operators.** `filter` and `update-expression-builder` get tables of `(input, query, expected_match)` tuples. New operators add rows.
8. **Validators tested as functions.** Each `validateX`: invalid input throws with the specific error type/message; valid input returns normally. Boundary rows (empty string, whitespace, leading/trailing slashes, control characters) are explicit.
9. **No `as any` in tests.** A single justified `as unknown as T` is allowed when simulating malformed DDB responses against defensive code.
10. **Strict assertion helpers replace the old `expectDynamoDBCalled`.** New helpers: `expectExactUpdateCommand`, `expectExactQueryCommand`, `expectExactPutCommand`, `expectExactDeleteCommand`, `expectNoUnexpectedCommands`. The old helper is deleted.
11. **Lint rule bans `expect.any(Number)` in committed tests.** A custom ESLint rule forbids `expect.any(Number)` / `expect.any(String)` *for known-deterministic shapes*. Suppressions require an inline comment explaining the genuine non-determinism.
12. **Each unit test names the failure mode it prevents.** Test titles read as bug reports: `"rejects undefined attribute values that DynamoDB silently drops"`, not `"works correctly"`.

## 5. Scope Additions — Gaps Beyond Strict Assertions

All fourteen included.

### A. LangGraph contract conformance

Run (or replicate) the upstream `BaseCheckpointSaver` and `BaseStore` contract suites against our implementations. Add `test/contract/{checkpointer,store,history}-conformance.test.ts`. These are mock-backed (the contract is shape, not DDB behavior). A LangGraph upgrade that changes the interface fails these tests immediately.

### B. Public-API surface lockdown

- `test/unit/index.test.ts` imports only from `src/index.ts` (i.e. the package entry point).
- `test/types/public-api.test-d.ts` uses `expectTypeOf` (or `tsd`) to lock the shape of every exported type. Renaming or removing an export fails CI.
- Generation of an exports manifest is *not* required; the type tests are sufficient and easier to maintain.

### C. AbortSignal & cancellation

Every action that accepts `signal` has tests for:
- Already-aborted signal short-circuits without issuing any DDB call.
- Abort mid-retry stops further attempts.
- The rejection is the documented error (`AbortError` or equivalent).

### D. Systematic reserved-words guard

`test/static/reserved-words-guard.test.ts` parses each `src/**/actions/*.ts` (and other expression builders), extracts every attribute name appearing in `UpdateExpression`, `ConditionExpression`, `FilterExpression`, `KeyConditionExpression`, `ProjectionExpression`, and fails if any unaliased name appears in DynamoDB's reserved-words list (vendored at `test/shared/fixtures/reserved-words-list.ts`). New attributes that collide fail at lint time, not at runtime in prod.

### E. DDB encoding limits & gotchas

Explicit tests for the library's behavior on:
- `undefined` values in maps (DDB DocumentClient silently strips by default — must be intentional).
- `NaN` / `Infinity` numbers (rejected by DDB).
- Numbers > `2^53` (precision lost).
- Items > 400KB (must route through S3 offload or reject with a clear error).
- Nested map depth > 32 (DDB hard limit).
- Empty-string attribute values (now allowed but historically not — confirm behavior).

Each case has a documented expected behavior (reject early / offload / coerce) verified by a test.

### F. S3 offload — failure & orphan paths

- Threshold off-by-one (payload exactly at the threshold).
- S3 PutObject 5xx mid-write — must not leave a half-written pointer.
- S3 PutObject succeeds then DDB Update fails — orphan must be detectable by `s3-orphans.ts`.
- DDB pointer present but S3 GetObject 404 — dangling reference handled.
- `test/integration/s3-orphans.integration.test.ts` exercises the orphan-cleaner against LocalStack.

### G. Nasty pagination cases

- Empty page with `LastEvaluatedKey` (filter eliminated all items on that page — code MUST keep paginating).
- Page exactly at `Limit`.
- Filter that eliminates every page until the last.
- `test/integration/store-pagination.integration.test.ts` covers these against DDB Local.

### H. Real optimistic-concurrency races

`test/integration/history-races.integration.test.ts` and `checkpointer-races.integration.test.ts` orchestrate two real concurrent clients against DDB Local using `test/integration/helpers/concurrency.ts` (a small `Promise.all` + barrier helper). Asserts: one client wins, the other retries successfully, final `messageCount` equals actual message count, no torn writes visible to a third reader.

### I. npm-pack smoke test

`test/package-smoke/pack-and-import.test.ts` (runs in its own CI job because it shells out):
1. `npm pack` the library.
2. Install the resulting tarball in a temp dir.
3. `import` from the published name.
4. Run a representative flow against DDB Local.

Catches `files` misconfigurations in `package.json`, missing `dist/`, broken `exports` map, missing peer-dep declarations.

### J. Per-file mutation kill criteria

`stryker.conf.json` gets `thresholds` configured per file (Stryker supports `thresholds.high`/`low`/`break` globally, but per-file thresholds require post-processing the JSON report). Implementation: a small Node script in CI parses the Stryker report and fails the build if any file falls below its declared threshold (see §6 for the threshold table). Aggregate score is reported but not gating.

### K. Logger discipline

For each `try/catch` and retry path, assert the logger emitted the expected fields (`error.name`, `error.message`, `attempt`, `tableName`, `userId` *redacted appropriately*). New helper: `test/shared/helpers/logger-capture.ts` snapshots structured log output, asserted with `.toMatchObject`. Production alerting depends on these fields — silent renames break ops.

### L. Determinism guard

- `jest.config` `globalSetup` installs fake timers, freezes `Date.now()` to a fixed epoch, seeds `Math.random()` via a deterministic shim.
- No `Math.random()` in fixtures (lint rule).
- Integration tests run in serial within a file but parallel across files; each file uses a `uniquePrefix()` (already implemented in `test/integration/helpers/ddb-local.ts`).
- CI merge-gate job re-runs each integration test ×3 (`jest --runInBand --testPathPattern=integration --rerunFailedTests=0` plus a wrapper script). Any test that isn't 3-for-3 fails the build. This is the flake gate.

### M. Exact backoff schedules

`retry.test.ts` pins attempt count, delays, and jitter math with fake timers. If retry is `expBackoff(base=100, factor=2, jitter=±20%, attempts=5)`, the test asserts:
- Attempts 1–5 fire at times `0, 100±20, 200±40, 400±80, 800±160` (with seeded jitter).
- A 6th attempt does *not* fire.
- Each attempt sends the same DDB input.

### N. Embedding edge cases

- Vector dimension mismatch across calls in the same batch.
- Embedding service returns `null` or fewer vectors than documents.
- `NaN` entries in vectors.
- Empty input array (no call should be made).
- `embedDocuments` throwing — must abort the put, not leave a half-written row.

`test/integration/store-embeddings.integration.test.ts` covers the integration-level flow with a deterministic embedding mock.

## 6. Coverage & CI

### 6.1 Unit coverage thresholds (jest.config)

```js
coverageThreshold: {
  global: { branches: 90, functions: 95, lines: 95, statements: 95 },
}
```

### 6.2 Per-file mutation thresholds

| File | Min mutation score |
|---|---|
| `src/shared/utils/retry.ts` | 90% |
| `src/shared/utils/compressor.ts` | 90% |
| `src/shared/utils/ttl.ts` | 90% |
| `src/shared/utils/batch-write.ts` | 85% |
| `src/shared/utils/s3-offloader.ts` | 85% |
| `src/store/utils/filter.ts` | 90% |
| `src/store/utils/validation.ts` | 85% |
| `src/history/utils/update-expression-builder.ts` | 90% |
| `src/history/utils/optimistic-retry.ts` | 90% |
| `src/history/utils/validation.ts` | 85% |
| `src/history/utils/title-generator.ts` | 80% |
| `src/history/session-adapter.ts` | 80% |
| `src/checkpointer/utils/validation.ts` | 85% |
| `src/checkpointer/utils/deserialization.ts` | 80% |

A file falling below its declared threshold fails CI.

### 6.3 CI pipeline order (fail-fast)

1. `typecheck` (`tsc --noEmit`)
2. `lint` (eslint — includes `expect.any(Number)` ban and `Math.random in fixtures` ban)
3. `unit` + `types` (`jest test/unit test/types`)
4. `static` + `contract` (`jest test/static test/contract`)
5. `integration` against `docker compose up -d` — merge-gate job re-runs each integration file ×3 (L)
6. `mutation` (`stryker run`) — gated to PRs touching `src/**`
7. `package-smoke` — release-branch and weekly

### 6.4 Node matrix

Node 22 (`engines.node` minimum) and Node 24 (latest LTS).

## 7. File Layout

```
test/
├── unit/                                       # mirrors src/
│   ├── shared/utils/{compressor,retry,sleep,ttl,batch-write,client-factory,constants,logger,s3-offloader,s3-orphans}.test.ts
│   ├── store/actions/{get,list-namespaces,put,search}-operation.test.ts
│   ├── store/utils/{filter,validation}.test.ts
│   ├── history/actions/{add-message,add-messages,clear,get-messages,list-sessions}.test.ts
│   ├── history/session-adapter.test.ts
│   ├── history/utils/{optimistic-retry,title-generator,update-expression-builder,validation}.test.ts
│   ├── checkpointer/actions/{delete-thread,get-tuple,put-writes,put,validate-configurable,writer}.test.ts
│   ├── checkpointer/utils/{deserialization,validation}.test.ts
│   ├── factory.test.ts
│   └── index.test.ts                           # imports only from src/index.ts
├── static/
│   └── reserved-words-guard.test.ts            # D
├── contract/                                   # A
│   ├── checkpointer-conformance.test.ts
│   ├── store-conformance.test.ts
│   └── history-conformance.test.ts
├── types/
│   └── public-api.test-d.ts                    # B
├── integration/
│   ├── helpers/
│   │   ├── ddb-local.ts                        # keep, currently solid
│   │   ├── localstack.ts                       # keep
│   │   ├── concurrency.ts                      # NEW — H
│   │   └── frozen-time.ts                      # NEW — deterministic time in integ
│   ├── checkpointer-flow.integration.test.ts
│   ├── checkpointer-s3-offload.integration.test.ts
│   ├── checkpointer-races.integration.test.ts  # H
│   ├── history-flow.integration.test.ts
│   ├── history-races.integration.test.ts       # H
│   ├── store-flow.integration.test.ts
│   ├── store-pagination.integration.test.ts    # G
│   ├── store-embeddings.integration.test.ts    # N
│   ├── s3-offload-failures.integration.test.ts # F
│   └── s3-orphans.integration.test.ts          # F
├── package-smoke/
│   └── pack-and-import.test.ts                 # I
└── shared/
    ├── fixtures/
    │   ├── test-data.ts                        # rewrite
    │   └── reserved-words-list.ts              # NEW — vendored DDB reserved-words list
    ├── helpers/
    │   ├── strict-ddb-assertions.ts            # replaces assertions.ts
    │   ├── frozen-time.ts                      # NEW
    │   ├── abort.ts                            # NEW — signal helpers
    │   ├── logger-capture.ts                   # NEW — K
    │   ├── test-setup.ts                       # rewrite — strict-only mocks
    │   └── validation-tests.ts                 # rewrite
    └── mocks/
        ├── dynamodb.ts                         # rewrite — rejects unexpected calls
        ├── embedding.ts                        # rewrite — with edge-case helpers
        └── s3.ts                               # NEW
```

## 8. Implementation Phasing — Five PRs

Each PR is independently mergeable. Each leaves `main` green.

### PR 1 — Scaffold + delete

- Delete every `test/**/*.test.ts` file. Delete the contents of `test/shared/` (helpers, fixtures, mocks) — they will be replaced. Keep `test/integration/helpers/{ddb-local,localstack}.ts` (they're solid) and `docker-compose.yml`.
- Add new helpers: `test/shared/helpers/{strict-ddb-assertions,frozen-time,abort,logger-capture,test-setup,validation-tests}.ts`, new fixtures, new mocks (see §7).
- Rewrite `jest.config` for strict coverage/determinism defaults.
- Add ESLint rules: ban `expect.any(Number)`-on-deterministic-shapes (custom rule), ban `Math.random` in `test/shared/fixtures/`.
- Add Stryker per-file threshold config + a post-processing script in CI.
- Add the static reserved-words list to `test/shared/fixtures/reserved-words-list.ts`.
- CI passes because there are zero tests (or only the scaffolding tests for the helpers themselves).

### PR 2 — Pure-logic unit tests + static guards + mutation gates live

- All `*/utils/` and `shared/utils/` unit tests with strict assertions.
- `test/static/reserved-words-guard.test.ts`.
- Stryker per-file thresholds enforced in CI.

This phase delivers the bulk of the "real coverage" gain because pure-logic files are where strict tests + mutation testing have the most leverage.

### PR 3 — Action unit tests

- Strict-shape unit tests for every action in `store/`, `history/`, `checkpointer/`.
- `factory.test.ts` and `index.test.ts` (public-surface smoke).
- AbortSignal tests (C) added inline with each action.
- Logger discipline assertions (K) added inline with retry/error paths.
- Embedding edge-case unit tests (N) added with `store/actions/put-operation.test.ts` and `search-operation.test.ts`.

After PR 3, the unit suite is complete.

### PR 4 — Integration & contract tests

- Rewrite existing `test/integration/*.test.ts` into new layout.
- Add the new ones: races (H), pagination edges (G), S3 failures + orphans (F).
- Add LangGraph contract conformance (A) in `test/contract/`.
- CI gains the integration job with the ×3 flake gate (L).

### PR 5 — Types, packaging, CI hardening

- `test/types/public-api.test-d.ts` (B).
- `test/package-smoke/pack-and-import.test.ts` (I).
- CI matrix expands to Node 22 + 24.
- Mutation report publishing (HTML artifact in CI for visibility).
- Backoff-schedule exact-timing test (M) wired in.
- Any logger-output assertions missed in PRs 2/3 retroactively added.

After PR 5, the new suite is the baseline. Regressions to looseness are caught by code review and the lint rule.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Strict assertions are brittle and slow new feature work. | Strictness is the point — drift should fail. Helpers (`strict-ddb-assertions.ts`) keep the boilerplate small. |
| Integration tests are flaky in CI. | ×3 flake gate (L), unique table prefixes per file (already implemented), serial-within-file. |
| Stryker runs are slow. | Gated to PRs touching `src/**`; runs nightly otherwise. |
| LangGraph upstream changes break contract tests. | This is intentional — contract drift must surface. Pin LangGraph in `package.json`; upgrade in a dedicated PR that addresses any contract-test failures. |
| The delete-everything PR loses coverage temporarily between PRs 1 and 3. | Acceptable — `main` between these PRs is the same `main` we have today (worse, even), but no release happens between them. Plan releases for after PR 5. |
| Custom ESLint rule for `expect.any` is hard to write. | Start with a regex-grep CI check; upgrade to a proper ESLint rule once the pattern is stable. |

## 10. Done When

- PRs 1–5 are merged.
- `npm test` runs only the new layout and passes deterministically (3-for-3 in CI).
- `npm run test:integration` passes against `docker compose up -d` 3-for-3.
- `npm run test:mutate` hits per-file thresholds in §6.2.
- `npm run lint` enforces the `expect.any` ban.
- Acceptance bug-injection check: for each of the 14 gap-classes (A–N), a deliberately-broken version of the corresponding source line is committed to a scratch branch; the new suite catches every one. This is the "did the rewrite actually do its job" gate, run once before declaring the rewrite complete.

## 11. Open Questions

None outstanding. All design decisions agreed during brainstorming on 2026-05-28.
