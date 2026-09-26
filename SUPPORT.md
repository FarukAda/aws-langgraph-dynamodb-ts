# Support

This is an open-source project maintained by one person in their own time. Response times are best effort.

It is an independent project: **not affiliated with, endorsed by, or sponsored by** Amazon Web Services, Inc. or LangChain, Inc. Support for it comes from here, not from either of them — an issue with DynamoDB or S3 themselves belongs with AWS Support, and one with `@langchain/langgraph`, `@langchain/langgraph-checkpoint` or `@langchain/core` belongs in their own repositories.

- **Bugs and feature requests**: open an issue using the templates; they ask for the package, LangChain and Node versions and which features (`s3`, `compression`, `vectorBackend`, `ttl`) are configured, which is what a useful reproduction needs.
- **Questions**: open an issue; a blank issue is fine when none of the templates fit. This repository does not have GitHub Discussions enabled.
- **Security**: see [SECURITY.md](SECURITY.md) — never in a public issue.
- **What is stable**: see the README's [*Versioning and compatibility*](README.md#versioning-and-compatibility) section for the API, storage-layout and peer-range promises of `1.x`.

Before reporting, check the README's [*Known limitations*](README.md#known-limitations), [*Configuration reference*](README.md#configuration-reference), [*Error handling*](README.md#error-handling), [*Logging*](README.md#logging) and [*Operations*](README.md#operations) sections: most runtime surprises (throttling budgets, table scans, orphaned S3 objects, the `cause` of a wrapped AWS failure) are described there together with what to do.
