# 18. Run the live-AWS tier on release tags as a publish gate

## Status

Accepted.

## Context

Every tier that runs on a push or a pull request runs against mocks or
DynamoDB Local. Only the live-AWS tier (`npm run test:aws`) calls the real
DynamoDB, S3 and Bedrock, and several of this package's claims rest on how
those services behave rather than on how an emulator does: the records in
`docs/evidence` describe conditional writes, cancelled transactions, S3
conditional creates and bucket versioning as AWS answered them on the day
they were measured. Nothing re-checks them when a version is cut, so a claim
can go stale without anyone noticing.

A nightly scheduled run was tried and dropped (commit `c9bd34e`): it billed
the account every night for a question that only matters before a release,
and one suite calls Bedrock, so a run that retried or looped would spend
money with nobody watching. Since then the tier has run only when a
maintainer remembers to run it, and the release gate did not require it.

Assuming an AWS role from a workflow needs `id-token: write`, and in
`release.yml` that permission would also let the job mint an npm publish
credential, because npm Trusted Publishing authorises by repository and
workflow file.

## Decision

We run the live-AWS tier only when a release tag is pushed, in its own
workflow, and the release refuses to publish without its check.

`integration-live.yml` runs on `v*` tags and nothing else: no schedule and no
manual dispatch. Its job, `live-aws integration`, is on the list of checks
`release.yml` waits for (`scripts/required-checks.json`), and the release
counts only a successful run; a skipped or cancelled one blocks the release
the same way a failed one does. The job fails when the tier ran no test, and
every suite refuses to run without a region instead of guessing one.

## Consequences

Positive. Every published version was checked against the real services when
it was cut. The role that can create tables and buckets never shares a
workflow file with the credential that can publish.

Negative. Between releases a claim is only as fresh as the last tag. A live
failure blocks a release, including one caused by AWS rather than by this
package: a throttled account or a regional incident stops a publish until
the tier is re-run green, and the release workflow is then re-run as well,
because a release that already stopped does not resume on its own. There is
no way to run the gate itself without tagging; a maintainer can still run
`npm run test:aws` locally with their own credentials.

Neutral. The cost is bounded to one run per tag. The OIDC role named by the
repository variable or secret `AWS_TEST_ROLE_ARN` has to exist, and stay
scoped to `aws-langgraph-*test-*` tables and buckets, and the repository
variable or secret `AWS_TEST_REGION` has to be set, for any release to
publish.
