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
