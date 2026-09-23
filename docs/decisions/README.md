# Decision records

One record per decision that is expensive to reverse: what the situation was,
what we decided, and what it costs. They are written for a future developer
who is wondering why something is the way it is, and who would otherwise have
to reconstruct the reasoning from the code, which does not contain it.

Records are numbered sequentially and a number is never reused. A decision
that is later reversed keeps its record, marked superseded and pointing at the
one that replaced it, because the reasoning that led to it is what explains
why the replacement was needed.

`test/static/decision-records.test.ts` checks the shape: the five sections,
the numbering, and that no number is used twice.

| # | Decision | Status |
|---|---|---|
| [1](0001-ship-the-dynamodb-sdk-as-dependencies-and-langchain-and-s3-as-peers.md) | Ship the DynamoDB SDK as dependencies, LangChain and S3 as peers | Accepted |
| [2](0002-keep-every-adapter-in-one-table-under-a-structured-key.md) | Keep every adapter in one table under a structured key | Accepted |
| [3](0003-offload-large-payloads-to-s3-behind-a-descriptor.md) | Offload large payloads to S3 behind a descriptor | Accepted |
| [4](0004-write-each-s3-payload-once-under-a-unique-key.md) | Write each S3 payload once under a unique key | Accepted |
| [5](0005-leave-superseded-payloads-to-lifecycle-rather-than-delete-them.md) | Leave superseded payloads to lifecycle rather than delete them | Accepted |
| [6](0006-commit-a-checkpoint-in-one-transaction-and-verify-by-reading-back.md) | Commit a checkpoint in one transaction and verify by reading back | Accepted |
| [7](0007-stamp-every-row-with-a-format-version-and-refuse-newer-rows.md) | Stamp every row with a format version and refuse newer rows | Accepted |
| [8](0008-make-the-recency-index-opt-in-and-sharded.md) | Make the recency index opt-in and sharded | Accepted |
| [9](0009-treat-the-in-memory-reference-implementations-as-the-oracle.md) | Treat the in-memory reference implementations as the oracle | Accepted |
| [10](0010-store-every-channel-value-regardless-of-new-versions.md) | Store every channel value regardless of `newVersions` | Accepted |
| [11](0011-default-the-serializers-and-report-serde-refusals-as-validation.md) | Default the serializers, and report serde refusals as validation | Accepted |
| [12](0012-drop-a-corrupt-message-by-default-and-fail-only-when-asked.md) | Drop a corrupt stored message by default, and fail the read only when asked | Accepted |
| [13](0013-let-only-library-errors-cross-the-public-boundary.md) | Let only library errors cross the public boundary | Accepted; superseded in part by 19 |
| [14](0014-retry-through-one-classifier-and-bound-every-loop.md) | Retry through one classifier and bound every loop | Accepted; amended by 19 |
| [15](0015-gate-the-build-on-complete-coverage.md) | Gate the build on complete coverage | Accepted |
| [16](0016-specify-behaviour-against-primary-sources-only.md) | Specify behaviour against primary sources only | Accepted |
| [17](0017-do-not-cap-file-length-or-function-complexity.md) | Do not cap file length or function complexity | Accepted |
| [18](0018-run-the-live-aws-tier-on-release-tags-as-a-publish-gate.md) | Run the live-AWS tier on release tags as a publish gate | Accepted |
| [19](0019-raise-one-error-class-and-classify-aws-failures-in-one-place.md) | Raise one error class and classify AWS failures in one place | Accepted |
