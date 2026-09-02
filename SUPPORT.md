# Support

This is an open-source project maintained by one person in their own time. Response times are best effort.

- **Bugs and feature requests**: open an issue using the templates; they ask for the package, LangChain and Node versions and which features (`s3`, `compression`, `vectorBackend`, `ttl`) are configured, which is what a useful reproduction needs.
- **Questions**: GitHub Discussions, or an issue if you suspect a defect.
- **Security**: see [SECURITY.md](SECURITY.md) — never in a public issue.
- **What is stable**: see [docs/STABILITY.md](docs/STABILITY.md) for the API, storage-layout and peer-range promises of `1.x`.

Before reporting, check the [README](README.md) *Error handling*, *Logging* and *Operations* sections: most runtime surprises (throttling budgets, table scans, orphaned S3 objects, `UpstreamError` causes) are described there together with what to do.
