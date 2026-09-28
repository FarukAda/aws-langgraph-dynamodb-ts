/**
 * Report, and optionally delete, offloaded S3 objects that no live row names.
 *
 * Every offloaded object belongs to one row. Its key ends in the id of the
 * write that uploaded it, and it carries that row's key as `dynamodb-pk-b64` /
 * `dynamodb-sk-b64` user metadata. An object whose row is gone, or names
 * another object, is an ORPHAN and is what `--delete` removes. An object
 * whose row is past its `ttl` but still present is reported separately, as
 * EXPIRED, and is **never** deleted here: the checkpointer serves a
 * checkpoint's PAYLOAD row and its pending-WRITE rows without checking their
 * own `ttl` at all — only the checkpoint's META row's `ttl` gates whether the
 * checkpoint is served — so such a row is not necessarily absent to every
 * read yet, however long past its own `ttl` it is. It becomes deletable once
 * DynamoDB has actually removed the row, which the service documents
 * happening within a few days of `ttl`, with no fixed bound; a later run then
 * sees `row-gone`. Several things leave an orphan behind:
 * - a write that may still land after failing — no answer, or DynamoDB
 *   answering `TransactionInProgressException` or a server error — keeps its
 *   upload;
 * - a write whose read-back itself failed, so its own uploads could not be
 *   confirmed unreferenced;
 * - a best-effort delete fails;
 * - an exhausted compare-and-swap overwrites unconditionally.
 * With a `ttl`, the lifecycle rule `ensureS3LifecycleRule()` writes reclaims
 * them. Without one, nothing does, and this sweep is how they are found.
 *
 * PRECONDITION: every object under `--prefix` must belong to `--table`. An
 * object's key and its backlink both carry the row's `pk`/`sk` but no table
 * name (see `docs/guide.md#the-on-disk-layout`), so a `--table` that names
 * the wrong table makes that table's still-live objects decode to "no such
 * row." Concretely:
 * - `DEFAULT_PREFIX` — the parent of every adapter's own default `keyPrefix`
 *   (`langgraph-checkpoints/{checkpointer,store,history}/`) — is safe only
 *   when **one** table backs every adapter under it.
 * - With a table per adapter, sweep each adapter's own `keyPrefix` against
 *   its own table, not the shared base prefix.
 * - Tables that share a bucket need distinct `keyPrefix` values regardless.
 * For this reason `--delete` REQUIRES an explicit `--prefix`; the default
 * applies to report-only runs only (see `parseArgs`).
 *
 * As a further guard, `--delete` also refuses to run when there is something
 * to delete but not one checked object resolved to any row — live, expired
 * or superseded — in `--table` (see `main`). That catches a `--table` or
 * `--prefix` that matches nothing here at all; it does **not** catch a
 * prefix shared with another table's live objects — only an explicit,
 * adapter-scoped `--prefix` does that. It also cannot tell a genuinely
 * correct `--table` where every one of these objects really is an orphan
 * (for example, after every thread under this prefix was deleted) from a
 * wrong one; the remedy there is to confirm from the report and delete the
 * flagged keys directly, with the AWS CLI or console, rather than re-running
 * `--delete`.
 *
 * An object uploaded before `1.0.0-rc.2` carries no backlink at all —
 * `1.0.0-rc.1` set none — so it is always reported `UNREADABLE` and can never
 * be judged live, expired or gone. A flood of `UNREADABLE` lines is therefore
 * expected, and not a sign of a broken bucket, on a table an earlier release
 * wrote to.
 *
 * What it reads, in order:
 * 1. `ListObjectsV2` under the prefix, paginated.
 * 2. For each object older than `--min-age-hours`, a `HeadObject` for its backlink.
 * 3. A strongly consistent `GetItem` on that key.
 * An object younger than the minimum age is never judged, because its row may
 * not be written yet: a write uploads first, and its retries stop 300 s in.
 * For the same reason `--min-age-hours` cannot be set below 1: a write's
 * upload plus its 300 s write lifetime plus a request timeout stays well
 * inside one hour.
 *
 * Usage:
 *   node scripts/find-orphaned-payloads.mjs --bucket B --table T [--region R]
 *                                           --prefix P [--min-age-hours N] [--delete]
 *   node scripts/find-orphaned-payloads.mjs --bucket B --table T [--region R]
 *                                           [--min-age-hours N]   # report only; --prefix defaults
 *
 * Without `--delete` it writes nothing, and `--prefix` may be omitted (it
 * then defaults to `DEFAULT_PREFIX`, spanning every adapter). With `--delete`,
 * `--prefix` is required. It deletes the ORPHAN findings only — never an
 * EXPIRED one — in batches of up to 1000 keys. On a versioned bucket a delete
 * leaves a delete marker rather than erasing the object outright, but
 * freeing that storage needs more than this flag: `ensureS3LifecycleRule()`'s
 * noncurrent-version-expiration and delete-marker-reclaim rules do that when
 * a `ttl` is set — `ensureLifecycleFor` is a no-op without one. An operator
 * on a TTL-less deployment who wants that storage back adds rules of their
 * own, but **never** the `Expiration.Days` clause `ensureS3LifecycleRule()`
 * writes: with no `ttl`, no row ever expires, so that clause would delete
 * every live payload's *current* version once it turns that many days old.
 * Add only a `NoncurrentVersionExpiration` rule, plus the delete-marker-
 * reclaim rule unchanged (see README.md's "S3 lifecycle rules" section for
 * both shapes, including the one without `Expiration`).
 *
 * Exit code: 0 when the sweep and every requested delete succeeded; non-zero
 * when the sweep itself failed, when `--delete` was refused (see
 * PRECONDITION above), or when any object could not be deleted.
 *
 * Permissions: `s3:ListBucket` and `s3:GetObject` on the bucket, and
 * `dynamodb:GetItem` on the table. `--delete` also needs `s3:DeleteObject`.
 * These are the operator's to hold when running this script, whether or not
 * they happen to already sit on the application role too.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { isMain } from './is-main.mjs';

/** The key prefix swept when none is given; a static test pins it to `DEFAULT_S3_KEY_PREFIX`. */
export const DEFAULT_PREFIX = 'langgraph-checkpoints/';

/**
 * Hours an object must have existed before it is judged. It is far past the
 * 300 s a write's retries may take between its upload and its row, so an
 * object still waiting for its row is never reported.
 */
export const DEFAULT_MIN_AGE_HOURS = 24;

/**
 * The least `--min-age-hours` accepts. A write's upload, its 300 s write
 * lifetime and a request timeout on top stay well inside one hour; the
 * minimum age is the only guard against judging — and with `--delete`,
 * removing — an upload whose row has not been written yet, so it must never
 * be set low enough to erode that guard to nothing.
 */
const MIN_AGE_HOURS_FLOOR = 1;

/** One request's bound, and one idle socket's; a static test pins each to the library's own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/** `DeleteObjects` takes at most this many keys per request. */
const DELETE_BATCH = 1000;
const HOUR_MS = 60 * 60 * 1000;
const PK_FIELD = 'dynamodb-pk-b64';
const SK_FIELD = 'dynamodb-sk-b64';

/** Each flag that takes a value, and the field it fills. `--delete` takes none. */
const FLAGS = {
  '--bucket': 'bucket',
  '--table': 'table',
  '--region': 'region',
  '--prefix': 'prefix',
  '--min-age-hours': 'minAgeHours',
};

/** `--flag=value` split into its two halves; a bare `--flag` yields no value. */
function splitFlag(argument) {
  const equals = argument.indexOf('=');
  if (equals < 0) return [argument, undefined];
  return [argument.slice(0, equals), argument.slice(equals + 1)];
}

/** `--min-age-hours` as a number, refusing anything below the floor. */
function minAgeHoursOf(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < MIN_AGE_HOURS_FLOOR) {
    throw new Error(
      `--min-age-hours must be a number of hours >= ${MIN_AGE_HOURS_FLOOR} (a write's upload plus its ` +
        `300 s write lifetime plus a request timeout stays well inside ${MIN_AGE_HOURS_FLOOR} hour), ` +
        `not "${value}"`,
    );
  }
  return hours;
}

/**
 * A path segment that names something other than itself, or nothing at all —
 * mirrors `UNSCOPED_SEGMENTS` in `src/shared/codec/s3/config.ts`.
 */
const UNSCOPED_SEGMENTS = new Set(['', '.', '..']);

/**
 * Refuse a `--prefix` that does not scope the objects this sweep may delete
 * to one real path — the same shape and segment rule `assertScopedKeyPrefix`
 * enforces on `s3.keyPrefix` in `src`. An empty or root prefix would judge,
 * and with `--delete` remove, objects across the *whole* bucket rather than
 * one adapter's, and a prefix without a trailing `/`, or one holding an
 * empty, `.` or `..` segment, can match a sibling path it was never meant to.
 */
function assertScopedPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix === '' || prefix === '/' || !prefix.endsWith('/')) {
    throw new Error(
      '--prefix must be a non-empty path ending in "/" (for example "langgraph-checkpoints/"), not ' +
        JSON.stringify(prefix),
    );
  }
  const segments = prefix.slice(0, -1).split('/');
  if (segments.some((segment) => UNSCOPED_SEGMENTS.has(segment))) {
    throw new Error(
      `--prefix must name a real path: no empty, "." or ".." segment, not ${JSON.stringify(prefix)}`,
    );
  }
}

/**
 * The sweep's settings, from `--flag value` or `--flag=value` pairs, and the
 * bare `--delete`.
 *
 * Throws when a flag is unknown or has no value, when `--delete` is given a
 * value, when `--bucket` or `--table` is missing, when `--min-age-hours` is
 * below its floor, when `--prefix` does not scope a real path, or when
 * `--delete` is given without an explicit `--prefix` (see the module header:
 * the default prefix spans every adapter, so it is safe for `--delete` only
 * when the caller has affirmatively chosen it).
 */
export function parseArgs(argv) {
  const parsed = {
    bucket: undefined,
    table: undefined,
    region: undefined,
    prefix: DEFAULT_PREFIX,
    minAgeHours: DEFAULT_MIN_AGE_HOURS,
    delete: false,
  };
  let prefixGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = splitFlag(argv[index]);
    if (flag === '--delete') {
      if (inline !== undefined) throw new Error('"--delete" takes no value');
      parsed.delete = true;
      continue;
    }
    const field = FLAGS[flag];
    if (field === undefined) {
      throw new Error(
        `unknown argument "${flag}"; accepted: ${[...Object.keys(FLAGS), '--delete'].join(' ')}`,
      );
    }
    let value = inline;
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined) throw new Error(`"${flag}" needs a value`);
    if (flag === '--prefix') prefixGiven = true;
    parsed[field] = field === 'minAgeHours' ? minAgeHoursOf(value) : value;
  }
  if (parsed.bucket === undefined) throw new Error('--bucket is required');
  if (parsed.table === undefined) throw new Error('--table is required');
  assertScopedPrefix(parsed.prefix);
  if (parsed.delete && !prefixGiven) {
    throw new Error(
      '--delete requires an explicit --prefix: the default prefix ' +
        `("${DEFAULT_PREFIX}") spans every adapter's objects, so with a table per adapter a --delete ` +
        'run against it can find another adapter\'s live objects "gone" in this --table and delete ' +
        "them. Pass --prefix explicitly — this adapter's own keyPrefix when tables are split per " +
        'adapter, or the base prefix again when one table backs every adapter under it.',
    );
  }
  return parsed;
}

/**
 * One base64url metadata value as the text it encodes, or null when the value
 * is not the base64url of anything usable; re-encoding is what tells a real
 * backlink from a garbage one, since Node's decoder drops what it cannot read.
 */
function decodePart(value) {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  if (text.length === 0) return null;
  return Buffer.from(text, 'utf8').toString('base64url') === value ? text : null;
}

/** The DynamoDB key an object's metadata points back at, or null when the pair is not readable. */
export function decodeBacklink(metadata) {
  if (metadata === undefined || metadata === null) return null;
  const lowered = {};
  for (const [name, value] of Object.entries(metadata)) lowered[name.toLowerCase()] = value;
  const pk = lowered[PK_FIELD];
  const sk = lowered[SK_FIELD];
  if (typeof pk !== 'string' || typeof sk !== 'string') return null;
  const decoded = { pk: decodePart(pk), sk: decodePart(sk) };
  return decoded.pk === null || decoded.sk === null ? null : decoded;
}

/** Whether an unmarshalled row still references `s3Key` anywhere, under any descriptor attribute. */
export function rowNamesKey(item, s3Key) {
  if (item === null || typeof item !== 'object') return false;
  if (!Array.isArray(item) && item.location === 'S3' && item.s3Key === s3Key) return true;
  return Object.values(item).some((value) => rowNamesKey(value, s3Key));
}

/**
 * Why an object whose row was read no longer belongs there, or null when a
 * live row still names it.
 *
 * `'row-expired'` means the row's own `ttl` has passed, but that is *not* the
 * same as absent to every reader: `store.get`/`search`, `history.getMessages`
 * and a checkpoint's own META-row read each already hide such a row, but a
 * checkpoint's PAYLOAD row and its pending-WRITE rows are served without
 * checking their own `ttl` at all — only their checkpoint's META row gates
 * whether the checkpoint is served — so this row can still be read, and its
 * object downloaded, until DynamoDB actually removes it. `sweep` never treats
 * this reason as deletable; see the module header.
 */
export function orphanReason(row, key, now = Date.now()) {
  if (row === null) return 'row-gone';
  if (typeof row.ttl === 'number' && row.ttl <= Math.floor(now / 1000)) return 'row-expired';
  if (!rowNamesKey(row, key)) return 'row-names-another-object';
  return null;
}

/**
 * Each `ListObjectsV2` page's objects under `prefix`, handed to `onPage` in
 * order.
 *
 * Throws when a page claims more pages (`IsTruncated: true`) but gives no
 * `NextContinuationToken`: continuing would resend the same request with no
 * token, which S3 reads as "start over," turning a malformed response into a
 * silent infinite loop over the pages already read rather than a visible
 * failure.
 */
async function eachObjectPage(s3, { bucket, prefix }, onPage) {
  let token;
  for (;;) {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    await onPage(page.Contents ?? []);
    if (page.IsTruncated !== true) return;
    if (page.NextContinuationToken === undefined) {
      throw new Error(
        'ListObjectsV2 reported IsTruncated=true with no NextContinuationToken; refusing to restart ' +
          'the listing from the beginning, which would repeat the pages already read forever',
      );
    }
    token = page.NextContinuationToken;
  }
}

/** An object's backlink, or null with the reason recorded; one unreadable object must not end the sweep. */
async function readBacklink(s3, bucket, key, result) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const backlink = decodeBacklink(head.Metadata);
    if (backlink !== null) return backlink;
    result.unreadable.push({ key, reason: `no readable ${PK_FIELD} / ${SK_FIELD} pair` });
  } catch (error) {
    result.unreadable.push({ key, reason: error.name ?? 'HeadObject failed' });
  }
  return null;
}

/** The row at `(pk, sk)` read consistently: the item, null when there is none, undefined when the read failed. */
async function readRow(ddb, { table, pk, sk }, key, result) {
  try {
    const response = await ddb.send(
      new GetItemCommand({
        TableName: table,
        Key: { PK: { S: pk }, SK: { S: sk } },
        ConsistentRead: true,
      }),
    );
    return response.Item === undefined ? null : unmarshall(response.Item);
  } catch (error) {
    result.unreadable.push({
      key,
      reason: `GetItem pk=${JSON.stringify(pk)} sk=${JSON.stringify(sk)} failed: ${error.name ?? 'unknown error'}`,
    });
    return undefined;
  }
}

/**
 * Sweep one prefix and report the objects no live row names. Reads only.
 * `s3` and `ddb` are anything with a `send`, so the tests drive it with fakes;
 * one page of the listing is held at a time.
 *
 * `result.orphans` holds only what `--delete` may remove (`row-gone` and
 * `row-names-another-object`); `result.expired` holds every `row-expired`
 * finding separately, since none of those are ever safe to delete here (see
 * the module header and {@link orphanReason}).
 */
export async function sweep({ s3, ddb, bucket, table, prefix, minAgeHours, now = Date.now() }) {
  const result = {
    bucket,
    table,
    prefix,
    minAgeHours,
    pages: 0,
    objects: 0,
    tooYoung: 0,
    checked: 0,
    live: 0,
    unreadable: [],
    expired: [],
    orphans: [],
  };
  const cutoff = now - minAgeHours * HOUR_MS;
  await eachObjectPage(s3, { bucket, prefix }, async (contents) => {
    result.pages += 1;
    for (const object of contents) {
      result.objects += 1;
      const lastModified = new Date(object.LastModified).getTime();
      if (!(lastModified <= cutoff)) {
        result.tooYoung += 1;
        continue;
      }
      result.checked += 1;
      const backlink = await readBacklink(s3, bucket, object.Key, result);
      if (backlink === null) continue;
      const row = await readRow(ddb, { table, ...backlink }, object.Key, result);
      if (row === undefined) continue;
      const reason = orphanReason(row, object.Key, now);
      if (reason === null) {
        result.live += 1;
        continue;
      }
      const entry = {
        key: object.Key,
        pk: backlink.pk,
        sk: backlink.sk,
        reason,
        lastModified: new Date(lastModified),
        size: object.Size ?? 0,
      };
      if (reason === 'row-expired') result.expired.push(entry);
      else result.orphans.push(entry);
    }
  });
  return result;
}

/**
 * Delete `orphans` in batches of up to 1000 keys; returns what S3 reported it
 * could not delete.
 *
 * A batch whose `DeleteObjects` call itself throws — a throttle, a denial, a
 * transport failure — is caught rather than left to end the sweep: every key
 * in that batch is reported failed, since a thrown request tells nothing
 * about which of its keys (if any) were actually removed, and a caller must
 * be able to see the whole report rather than lose it to an unhandled
 * rejection partway through.
 */
export async function deleteOrphans(s3, bucket, orphans) {
  const failed = [];
  for (let start = 0; start < orphans.length; start += DELETE_BATCH) {
    const batch = orphans.slice(start, start + DELETE_BATCH);
    try {
      const response = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((orphan) => ({ Key: orphan.key })), Quiet: true },
        }),
      );
      for (const error of response.Errors ?? []) {
        failed.push({ key: error.Key, reason: error.Code ?? 'DeleteObjects failed' });
      }
    } catch (error) {
      const reason = error.name ?? error.message ?? 'DeleteObjects failed';
      for (const orphan of batch) failed.push({ key: orphan.key, reason });
    }
  }
  return failed;
}

/** One finding, as one line an incident channel can carry, under whichever `tag` names its kind. */
function formatFinding(tag, entry) {
  return [
    tag,
    `objectKey=${entry.key}`,
    `reason=${entry.reason}`,
    `pk=${JSON.stringify(entry.pk)}`,
    `sk=${JSON.stringify(entry.sk)}`,
    `lastModified=${entry.lastModified.toISOString()}`,
    `bytes=${entry.size}`,
  ].join(' ');
}

/** One deletable orphan, as one line an incident channel can carry. */
export function formatOrphan(orphan) {
  return formatFinding('ORPHAN', orphan);
}

/** One expired-but-not-yet-gone row's object, reported but never deleted. */
export function formatExpired(entry) {
  return formatFinding('EXPIRED', entry);
}

/**
 * The sweep's findings: what was swept, and what was found. Printed before
 * any delete is attempted, so a delete failure — or a refusal, see
 * {@link main} — never costs the operator the report.
 */
export function reportLines(result) {
  const lines = [
    `swept bucket=${result.bucket} prefix=${result.prefix} table=${result.table} ` +
      `minAgeHours=${result.minAgeHours}`,
    `listed ${result.objects} object(s) over ${result.pages} page(s): ${result.tooYoung} ` +
      `younger than the minimum age, ${result.checked} checked, ${result.live} named by a live row`,
  ];
  for (const row of result.unreadable) lines.push(`UNREADABLE objectKey=${row.key} reason=${row.reason}`);
  for (const entry of result.expired) lines.push(formatExpired(entry));
  for (const orphan of result.orphans) lines.push(formatOrphan(orphan));
  const bytes = result.orphans.reduce((sum, orphan) => sum + orphan.size, 0);
  lines.push(`${result.orphans.length} orphaned object(s), ${bytes} byte(s)`);
  if (result.expired.length > 0) {
    lines.push(
      `${result.expired.length} object(s) past their row's ttl but not yet removed by DynamoDB: never ` +
        "deleted here, since a checkpoint's PAYLOAD and pending-WRITE rows are served without their own " +
        'ttl checked. Re-run once DynamoDB has removed the row (it then reports row-gone) to delete the object.',
    );
  }
  return lines;
}

/**
 * What a delete attempt did, as report lines: `deletion` is undefined for a
 * dry run (no `--delete`) and `{ failed }` once {@link deleteOrphans} ran.
 */
export function deletionLines(result, deletion) {
  if (deletion === undefined) {
    return result.orphans.length > 0
      ? ['Nothing was deleted. Re-run with --delete to delete the orphans above.']
      : [];
  }
  const lines = [];
  for (const failure of deletion.failed) {
    lines.push(`DELETE-FAILED objectKey=${failure.key} reason=${failure.reason}`);
  }
  lines.push(`deleted ${result.orphans.length - deletion.failed.length} object(s)`);
  return lines;
}

/**
 * The config both clients are built from: a request handler that bounds a
 * request and an idle socket, under whatever the caller set — the same shape,
 * for the same reasons, as `find-stranded-payloads.mjs` uses.
 */
export function boundedClientConfig(clientConfig) {
  return {
    requestHandler: {
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
    ...clientConfig,
  };
}

const realS3 = (config) => new S3Client(config);
const realDynamoDB = (config) => new DynamoDBClient(config);

/**
 * Parse, announce what is about to be swept, sweep it, delete on request, and
 * print the report. `createS3`, `createDynamoDB` and `now` are seams for the
 * tests; the command line sets none of them.
 *
 * The findings print immediately after the sweep, before any delete is
 * attempted. With `--delete`, a sweep with something to delete but where not
 * one checked object resolved to any row — live, expired or superseded — in
 * `--table` refuses to delete anything: the signature of a `--table` or
 * `--prefix` that does not match these objects (see PRECONDITION in the
 * module header). Otherwise it deletes the orphans found, printing the
 * outcome and throwing (so the process exits non-zero) if any object could
 * not be deleted.
 */
export async function main(
  argv,
  { createS3 = realS3, createDynamoDB = realDynamoDB, now = Date.now() } = {},
) {
  const options = parseArgs(argv);
  const clientConfig = options.region === undefined ? {} : { region: options.region };
  console.log(
    `sweeping bucket=${options.bucket} prefix=${options.prefix} table=${options.table} ` +
      `region=${options.region ?? '(from the environment)'} minAgeHours=${options.minAgeHours}` +
      (options.delete ? ' delete=yes' : ''),
  );
  const s3 = createS3(boundedClientConfig(clientConfig));
  const ddb = createDynamoDB(boundedClientConfig(clientConfig));
  try {
    const result = await sweep({ s3, ddb, ...options, now });
    for (const line of reportLines(result)) console.log(line);
    if (!options.delete) {
      for (const line of deletionLines(result, undefined)) console.log(line);
      return;
    }
    const foundAnyRow =
      result.live +
      result.expired.length +
      result.orphans.filter((orphan) => orphan.reason === 'row-names-another-object').length;
    if (result.orphans.length > 0 && foundAnyRow === 0) {
      throw new Error(
        `refusing --delete: ${result.orphans.length} object(s) would be deleted, but not one of the ` +
          `${result.checked} checked object(s) resolved to a row in --table (${result.unreadable.length} ` +
          `unreadable, ${result.expired.length} expired, ${result.live} live). That is the signature of ` +
          'a wrong --table or --prefix. It can also mean --table is genuinely correct and every one of ' +
          'these really is an orphan (for example, after every thread under this prefix was deleted): if ' +
          'you have confirmed --table and --prefix, delete the keys the ORPHAN lines above name directly, ' +
          'with the AWS CLI or console, instead of re-running --delete.',
      );
    }
    const deletion = { failed: await deleteOrphans(s3, options.bucket, result.orphans) };
    for (const line of deletionLines(result, deletion)) console.log(line);
    if (deletion.failed.length > 0) {
      throw new Error(
        `--delete failed for ${deletion.failed.length} of ${result.orphans.length} object(s); see the ` +
          'DELETE-FAILED lines above',
      );
    }
  } finally {
    s3.destroy();
    ddb.destroy();
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // Neutral, not "sweep failed": this also reports a bad argument, a
    // refused --delete and a delete failure, none of which is the sweep
    // itself failing.
    console.error(`find-orphaned-payloads.mjs: ${error.message}`);
    process.exitCode = 1;
  });
}
