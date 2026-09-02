# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes — fixes ship in the latest minor |
| 0.x | no — upgrade to 1.x |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use one of:

- **GitHub private vulnerability reporting**: the *Security* tab of this repository → *Report a vulnerability*.
- **Email**: info@farukada.com with `SECURITY` in the subject.

Include the package version, a description of the issue, and steps or a proof of concept if you have one. You will get an acknowledgement within three business days. This is a single-maintainer project: the target is a fix or a mitigation within 14 days for a high or critical issue and within 30 days otherwise, with a coordinated disclosure and credit in the release notes if you want it. Vulnerabilities in the AWS SDK or in LangChain/LangGraph belong upstream; the maintainer will help route them.

## What the library does and does not do

- It never logs a payload, an embedding, a message body or a credential — only identifiers and counts (see the README's *Logging* section). `redactLogger` is opt-in and redacts secret-shaped keys and values in the structured arguments and in error text.
- Credentials come exclusively from the AWS SDK's default provider chain or the `clientConfig` you pass; the library stores none.
- S3 objects are written with server-side encryption (`AES256` by default, `aws:kms` with your key when configured). A row's `s3Key` is checked against the row's own identifiers before any download or delete, so a tampered row cannot reach another item's object.
- Decompression and S3 downloads are bounded (50 MiB each by default) so a hostile or corrupted payload cannot exhaust memory; every identifier is validated before it reaches DynamoDB or S3.
- Tenant isolation is anchored on the identifiers you choose; the README's *Multi-tenant deployments* section shows the IAM policy that enforces it and names the table-scan operations that are cross-tenant by construction.

## Verifying a release

Releases are published by the repository's release workflow with npm provenance. Verify an installed version with `npm audit signatures`, and compare the tarball contents with `npm pack --dry-run @farukada/aws-langgraph-dynamodb-ts@<version>` — only `dist/`, `LICENSE`, `README.md` and `package.json` ship.
