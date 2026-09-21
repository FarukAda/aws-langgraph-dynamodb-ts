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

**Write access to the table is code-path selection in every process that reads it.** A stored payload is bytes plus a serializer, and the checkpointer's default serializer — LangGraph's `JsonPlusSerializer`, inherited from `BaseCheckpointSaver` — reconstructs values rather than only parsing them. A record carrying an `lc` marker is a constructor record: `{"lc":1,"type":"constructor","id":["langchain_core","messages","HumanMessage"],"kwargs":{…}}` reads back as a real `HumanMessage`, built by calling that class with the arguments the row supplies. A second record shape, `{"lc":2,"type":"constructor",…}`, restores a `Map`, a `Set`, a `RegExp`, an `Error` or a `Uint8Array` from a fixed list of those five names, and that list never consults the allow-list. The row chooses which constructor runs; your code chooses only the allow-list the first shape is drawn from.

Measured, so that the boundary is stated at its real size and not larger:

- **The allow-list refusal covers one record shape.** A record that is `lc: 1`, `type: "constructor"` and carries an array `id` is resolved through LangChain's `load()`, and an `id` that allow-list does not contain — `["evil","Thing"]`, `["node","child_process","exec"]`, and equally `["langchain_core","messages","NoSuchMessage"]` — **fails the read** rather than resolving, as a `ValidationError` whose `context.field` is `serde`, identically on `saver.getTuple`, `store.get` and `history.getMessages`. It is **reported, never skipped**, including under `onCorruptMessage: 'skip'`: the bytes are undamaged, so the refusal states what this reader may reconstruct rather than that the payload is unreadable — and a row of this shape is exactly the one an operator must be told about. This is not a path to arbitrary code: no module outside the import maps `load()` consults can be named at all. It is wider than a list of classes, though, in two ways that a threat model should carry. The name is looked up across everything a resolved namespace exports and is then invoked with `new`, so an ordinary exported *function* resolves exactly as a class does, and many of the reachable exports are ordinary functions. And `load()` ends by renaming what it built — `Object.defineProperty(instance.constructor, "name", …)` — so a name whose function returns a plain object renames the **global `Object`** for the life of the process, after which every plain object in it reports `constructor.name` as whatever the row chose. That rename is the one effect of reading such a row that is not confined to the value the read returns.
- **No other record shape is refused, and two of them are not inert either.** An `lc: 2` constructor record naming anything outside the five names above — `{"lc":2,"type":"constructor","id":["child_process"],"method":"exec","args":["…"]}` — reads back as the plain object it is: nothing resolved, nothing invoked, **nothing raised**. So do an `lc: 1` record whose `id` is not an array, one whose `type` is not `"constructor"`, and an `lc` value that is neither 1 nor 2. Two further `lc: 2` shapes are not constructor records at all, and neither is returned as data: `{"lc":2,"type":"undefined"}` reads back as `undefined`, which **removes the key** from the object that held it rather than handing anything back, and `{"lc":2,"type":"delta_snapshot","value":…}` builds a LangGraph `DeltaSnapshot` around whatever the row put in `value`. Both are silent. So the refusal covers the one shape above, and inertness covers every shape but those two — which is why the refusal is containment and not detection: a planted row of any other shape is neutralised without a word, and the reader is handed a plain object, or nothing at all, where it expected a value. This is LangGraph's serializer, not this package's; the behaviour is stated here because a threat model is written against it.
- A stored `{"__proto__": {…}}` becomes the **revived object's own prototype** under that serializer, so a field reads as present through the object and absent through `Object.hasOwn`. It is confined to that object: the process-wide `Object.prototype` is not modified. The same bytes read through this package's plain-JSON serializer parse to an ordinary own key named `__proto__`, leaving the prototype alone.

**The control is to treat table write access as trusted access, and to scope it.** The `dynamodb:LeadingKeys` policy in the README's *Multi-tenant deployments* section is what keeps one tenant from writing rows into another tenant's partitions, and that is the same control as this one: a row planted in a partition is deserialised by whoever reads that partition. A role that may write the table should be reviewed as a role that may invoke allow-listed `langchain_core` exports inside every reader of it. The same applies to the S3 bucket holding offloaded payloads, whose objects are the payload bytes for large rows.

**A narrower option is available and supported.** `JSON_SERDE`, exported from the package root, is the plain-JSON serializer the store and chat-history adapters already default to; passing it as the checkpointer's `serde` makes the read `JSON.parse` and nothing else, so neither an `lc` record nor a `__proto__` key changes what a read produces. It is not free: it stores the JSON projection of a value rather than the value (the README's *Table schema* section tabulates exactly what that loses), and because nothing on a row records which serializer wrote it — both defaults tag their bytes `"json"` for every value but a raw `Uint8Array`, which `JsonPlusSerializer` alone writes and tags `"bytes"`, and which `JSON_SERDE` refuses rather than parses — switching it changes how existing rows read. The README's *Trust boundary* section carries the full trade-off.

What this boundary does **not** change, because those bounds hold whichever serializer is configured: an offloaded object must live under the reading row's own identifiers, downloads and decompression are capped, and a payload descriptor the reader does not understand is refused rather than guessed at. Telling a payload that rotted apart from one the serializer declined to rebuild re-reads the same bytes once with a bare `JSON.parse` — no reviver, no constructor record, and only on a path where a decode has already failed — so that classification adds no revival surface beyond the one the configured serializer already attempted.

## What the library does and does not do

- It never logs a payload, an embedding, a message body or a credential — only identifiers and counts (see the README's *Logging* section). `redactLogger` is opt-in and redacts secret-shaped keys and values in the structured arguments and in error text.
- Credentials come exclusively from the AWS SDK's default provider chain or the `clientConfig` you pass; the library stores none.
- S3 objects are written with server-side encryption (`AES256` by default, `aws:kms` with your key when configured). A row's `s3Key` is checked against the row's own identifiers before any download or delete, so a tampered row cannot reach another item's object.
- Decompression and S3 downloads are bounded (50 MiB each by default) so a hostile or corrupted payload cannot exhaust memory; every identifier is validated before it reaches DynamoDB or S3.
- Tenant isolation is anchored on the identifiers you choose; the README's *Multi-tenant deployments* section shows the IAM policy that enforces it and names the table-scan operations that are cross-tenant by construction.

## Verifying a release

Releases are published by the repository's release workflow with npm provenance. Verify an installed version with `npm audit signatures`, and compare the tarball contents with `npm pack --dry-run @farukada/aws-langgraph-dynamodb-ts@<version>` — only `dist/`, `LICENSE`, `README.md` and `package.json` ship.
