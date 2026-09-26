# S3 versioning and lifecycle shapes, for the containment layer

Run conditions: run 1 (and run 4 for E-12) in [`README.md`](./README.md). Every probe issued against the
raw SDK against a bucket created for the run and deleted after.

## E-9: `GetBucketVersioning` distinguishes never-versioned, enabled and suspended

**Request** — `GetBucketVersioning` on a bucket in each of the three states.

**Response**

```
[never versioned] -> Status=(absent) full={} httpStatus=200
[enabled]         -> Status=Enabled   full={"Status":"Enabled"}   httpStatus=200
[suspended]       -> Status=Suspended full={"Status":"Suspended"} httpStatus=200
```

**What this settles.** All three states are distinguishable, and a never-versioned
bucket answers `200` with an **empty body** — `Status` is `undefined`, not
`'Disabled'` or any other string token. A caller that wants to throw with distinct
messages for "never versioned" and "suspended" must test the absent case as
`Status === undefined`, never as a string comparison.

**What the probe did not cover.** Nothing further; the three states are the whole
domain `GetBucketVersioning` returns.

## E-10: deleting a versioned object leaves a delete marker, and the prior version stays readable by id

**Request** — `PutObject`; `DeleteObject` with no version id; `GetObject` with no
version id; `GetObject` with the original `VersionId`; `ListObjectVersions`.

**Response**

```
PutObject VersionId=06GuQFqzj9cFdmevHkVpBiwNisf3mdkM ETag="0669d985118922537762da81510280a2"
DeleteObject (no version id) -> DeleteMarker=true VersionId=aE4MJXDssiEzcp87j6rYcWxv5Cl6ulpn status=204
GetObject (no version id)    -> name=NoSuchKey Code=NoSuchKey status=404
GetObject (VersionId=06Gu…) -> "the payload" status=200
ListObjectVersions Versions=[{"Key":"...","VersionId":"06Gu…","IsLatest":false}]
ListObjectVersions DeleteMarkers=[{"Key":"...","VersionId":"aE4M…","IsLatest":true,"LastModified":"..."}]
```

**What this settles.** A delete on a versioned bucket does not erase the object: it
leaves a delete marker as the latest entry, the versionless read fails with
`NoSuchKey`/404, and the payload survives and reads back byte-identical by version
id. `ListObjectVersions` separates delete markers into their own `DeleteMarkers`
array — filtering to markers is a field selection, not a heuristic — and each one
carries a `LastModified` timestamp a sweep can use to compute remaining grace.

**What the probe did not cover.** A `ListObjectVersions` response spanning more
than one page.

## E-11: a lifecycle rule cannot share one `Expiration` between `Days` and `ExpiredObjectDeleteMarker`

**Request** — `PutBucketLifecycleConfiguration` with one rule whose single
`Expiration` carries both `Days` and `ExpiredObjectDeleteMarker: true`.

**Response**

```
REFUSED: name=MalformedXML Code=MalformedXML status=400
msg=The XML you provided was not well-formed or did not validate against our published schema
```

The shape this package writes instead — `ExpiredObjectDeleteMarker` in the
`Expiration` of a **second** rule, next to a separate rule carrying
`Expiration{Days}` — is accepted and round-trips unchanged on read-back. That is
asserted on every run, not by E-11's test but by the lifecycle provisioning test
beside it ("provisions both rules, reads them back unchanged, and then writes
nothing", `test/aws/real-aws-s3-lifecycle.test.ts`).

**Measured, but not asserted by any live test.** The probe also saw S3 accept
`ExpiredObjectDeleteMarker` in its own `Expiration` alone, and beside a
`NoncurrentVersionExpiration` in the same rule. This package never sends either
shape, so no live test re-checks them; they are recorded as the observation they
were, not as a claim the live tier keeps true.

**What this settles.** `ExpiredObjectDeleteMarker` cannot share one `Expiration`
block with `Days`/`Date` — this matches the S3 API reference's stated constraint,
now confirmed live rather than only documented. A deployment that wants both a TTL
and marker reclamation needs a **second** lifecycle rule.

**What the probe did not cover.** The `Date` variant of the same conflict (only
`Days` was tried) — the API reference states the same constraint for both, and
`Days` is the only one this package ever sends.

## E-12: under suspended versioning, writes get a null version id and old versions survive untouched

**Request** — enable versioning; write an object; suspend versioning; `PutObject`
twice more; `DeleteObject`; list versions and markers; read the enabled-era
version by its version id.

**Response**

```
PutObject under suspension        -> VersionId=undefined
second PutObject under suspension -> VersionId=undefined
DeleteObject under suspension     -> DeleteMarker=true VersionId=null
versions now: []
markers now:  [{"VersionId":"null"}]
enabled-era version still readable: "the payload"
```

Run 4, listing every version of the key after the delete:

```
null versions now: []
other versions now: [{"VersionId":"<the enabled-era id>","IsLatest":false}]
```

Run 1 also read the enabled-era version back by its id, so its `versions now: []`
can only have counted null versions: the enabled-era version is still in the key's
version list, no longer the latest.

**What this settles.** Writes made under `Suspended` versioning get the null
version id, and a second such write **replaces** the first (the earlier null
version disappears — no null version is left — rather than accumulating), and a delete
leaves a null-version delete marker, so the payload really is destroyed. An object
version written **while versioning was enabled** survives suspension untouched and
stays readable by its version id — the bucket keeps that old version, and its
storage cost, while giving new writes no protection at all.

**What the probe did not cover.** Re-enabling versioning after a suspension, and
whether an enabled-era version can be restored by copying it back to the head of
the key.
