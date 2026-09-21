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

## The deserialisation trust boundary

**Write access to the table is code-path selection in every process that reads it.** A stored payload is bytes plus a serializer, and the checkpointer's default serializer — LangGraph's `JsonPlusSerializer`, inherited from `BaseCheckpointSaver` — reconstructs values rather than only parsing them. A record carrying an `lc` marker is a constructor record: `{"lc":1,"type":"constructor","id":["langchain_core","messages","HumanMessage"],"kwargs":{…}}` reads back as a real `HumanMessage`, built by calling that class with the arguments the row supplies. `Map`, `Set` and `Uint8Array` are restored the same way. The row chooses which constructor runs; your code chooses only the allow-list it is drawn from.

Measured, so that the boundary is stated at its real size and not larger:

- An `id` the allow-list does not contain — `["evil","Thing"]`, `["node","child_process","exec"]` — **fails the read** rather than resolving. This is not a path to arbitrary code; it is a path to an allow-listed `langchain_core` class with attacker-chosen arguments.
- A stored `{"__proto__": {…}}` becomes the **revived object's own prototype** under that serializer, so a field reads as present through the object and absent through `Object.hasOwn`. It is confined to that object: the process-wide `Object.prototype` is not modified. The same bytes read through this package's plain-JSON serializer parse to an ordinary own key named `__proto__`, leaving the prototype alone.

**The control is to treat table write access as trusted access, and to scope it.** The `dynamodb:LeadingKeys` policy in the README's *Multi-tenant deployments* section is what keeps one tenant from writing rows into another tenant's partitions, and that is the same control as this one: a row planted in a partition is deserialised by whoever reads that partition. A role that may write the table should be reviewed as a role that may construct allow-listed classes inside every reader of it. The same applies to the S3 bucket holding offloaded payloads, whose objects are the payload bytes for large rows.

**A narrower option is available and supported.** `JSON_SERDE`, exported from the package root, is the plain-JSON serializer the store and chat-history adapters already default to; passing it as the checkpointer's `serde` makes the read `JSON.parse` and nothing else, so neither an `lc` record nor a `__proto__` key changes what a read produces. It is not free: it stores the JSON projection of a value rather than the value (the README's *Table schema* section tabulates exactly what that loses), and because nothing on a row records which serializer wrote it — both defaults tag their bytes `"json"` — switching it changes how existing rows read. The README's *Trust boundary* section carries the full trade-off.

What this boundary does **not** change, because those bounds hold whichever serializer is configured: an offloaded object must live under the reading row's own identifiers, downloads and decompression are capped, and a payload descriptor the reader does not understand is refused rather than guessed at.

## What the library does and does not do

- It never logs a payload, an embedding, a message body or a credential — only identifiers and counts (see the README's *Logging* section). `redactLogger` is opt-in and redacts secret-shaped keys and values in the structured arguments and in error text.
- Credentials come exclusively from the AWS SDK's default provider chain or the `clientConfig` you pass; the library stores none.
- S3 objects are written with server-side encryption (`AES256` by default, `aws:kms` with your key when configured). A row's `s3Key` is checked against the row's own identifiers before any download or delete, so a tampered row cannot reach another item's object.
- Decompression and S3 downloads are bounded (50 MiB each by default) so a hostile or corrupted payload cannot exhaust memory; every identifier is validated before it reaches DynamoDB or S3.
- Tenant isolation is anchored on the identifiers you choose; the README's *Multi-tenant deployments* section shows the IAM policy that enforces it and names the table-scan operations that are cross-tenant by construction.

## Verifying a release

Releases are published by the repository's release workflow with npm provenance. Verify an installed version with `npm audit signatures`, and compare the tarball contents with `npm pack --dry-run @farukada/aws-langgraph-dynamodb-ts@<version>` — only `dist/`, `LICENSE`, `README.md` and `package.json` ship.
