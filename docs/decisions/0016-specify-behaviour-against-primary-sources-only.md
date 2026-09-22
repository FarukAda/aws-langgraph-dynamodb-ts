# 16. Specify behaviour against primary sources only

## Status

Accepted.

## Context

DynamoDB and S3 each have other clients, in this language and others, and
copying a limit, a classification or an error's meaning from one of them is
faster than establishing it directly. It is also unreliable: a number
copied without its source cannot be re-derived when the service changes,
and a behaviour copied from another implementation may be that
implementation's own bug rather than a fact about the service. DynamoDB
Local, which the unit and integration tiers run against for speed, is
itself such a source to be wary of: `transactIdempotently`'s own doc
comment (`src/shared/dynamodb/idempotent-write.ts`) records that the
`IdempotentParameterMismatchException` a cancelled token's reused
parameters draw against real DynamoDB is "only observable against real
DynamoDB" — the local image re-evaluates the changed body instead of
reserving the parameters — so a behaviour observed only against the local
image is not a fact about DynamoDB at all.

Parts of both services are undocumented. For those there is no page to
cite — only what the service actually does, which can be observed but goes
stale silently the moment nobody re-observes it after a service change.

## Decision

We specify every behaviour against the AWS documentation for DynamoDB and
S3, the peer packages' own published source at the version this package
targets, or `docs/evidence/`, and cite whichever it came from where it is
implemented — record 10, for one example, cites
`@langchain/langgraph-checkpoint@1.1.5`'s and `@langchain/langgraph@1.4.13`'s
own source for what each passes as `newVersions`. Record 9's use of
`MemorySaver` and `InMemoryStore` as the behavioural oracle is this same
rule, not an exception to it: both are the peer packages' own published
source, not a third-party implementation of the problem this package
solves. What a *different* backend does, or what only DynamoDB Local does
when it disagrees with the real service, is never treated as a source.

Where AWS documents nothing, a claim needs two things before it can be
cited: a probe recorded under `docs/evidence/`, with its raw request and
response, and a named live test in `test/aws` asserting the same fact, so a
run against real AWS fails the moment the service changes.
`docs/evidence/README.md` states why both are required — the file alone
goes stale silently, and the test alone cannot be reviewed by someone
without AWS credentials to run it.

## Consequences

Positive. Every behavioural claim this package makes can be traced to
something a reader can re-check without taking the claim on trust, and
undocumented behaviour is held to a *higher* evidentiary standard —
a dated, re-runnable probe — than documented behaviour, not a lower one.

Negative. Establishing an undocumented fact costs a live run against a
real AWS account, which not every contributor can do, and `docs/evidence/`
is deliberately not run on a schedule, so a claim is only as fresh as the
maintainer's last run before a release — the run date recorded beside each
claim exists for exactly that reason.

Neutral. This rule does not forbid running tests against DynamoDB Local or
another emulator; it forbids treating what only the emulator does as a
fact about the service being emulated. The two tiers exist for different
reasons — DynamoDB Local for a fast, repeatable inner loop, the live tier
for the facts an emulator cannot be trusted to reproduce — and neither
substitutes for the other.
