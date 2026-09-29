# 15. Gate the build on complete coverage

## Status

Accepted.

## Context

This package's job is to be correct at a boundary a consumer cannot easily
exercise themselves — their alternative to trusting it is a live AWS
account and real spend. Most of what it does beyond the DynamoDB and S3
calls themselves is refuse malformed input in a way that names what was
wrong, or take a defensive branch for a case the SDK's own types allow but
that should never actually happen; a refusal path that no test ever
executes is a refusal that may not work when it finally has to.

A coverage target below 100 % invites the question of which lines are
allowed to stay uncovered, and that answer drifts over time as different
contributors make different calls about which gaps are acceptable. A
target at 100 % removes that question and replaces it with a different,
better one: whether the uncovered line should exist at all.

## Decision

We fail the build below 100 % of statements, branches, functions and lines
(`jest.config.mjs`), collected across everything under `src/` and enforced
on every `npm test` run. An optional feature earns no exemption from this:
record 8's sharded recency index, opt-in and off by default, is covered by
tests that turn it on and exercise its shard-selection and backfill code
paths exactly as thoroughly as the code every deployment runs.

## Consequences

Positive. Every branch, including every error path and every defensive
guard against a case the type system alone does not rule out, has been
executed by a test at least once. When a refactor leaves a branch
unreachable, the gate reports it immediately rather than letting dead code
accumulate silently until someone notices by inspection.

Negative. The gate can be satisfied by a test that executes a line without
asserting anything useful about it, so 100 % coverage on its own says
nothing about whether the assertions are any good — it measures execution,
not correctness. It also makes defensive code expensive to keep: every
guard against a case that "should never happen" now needs a test that
manufactures that case, which is a real and continuous pressure toward
deleting guards rather than proving them. The answer this package takes is
to write the test, not remove the guard, but the pressure is there on
every one regardless.

Neutral. A module that is types only compiles to nothing and is not
instrumented at all, so it neither helps nor hurts the number; splitting a
file to move type-only declarations out of it changes nothing about what
the gate reports for the code that remains.
