/**
 * Report, and optionally delete, offloaded S3 objects that no live row names.
 *
 * Every offloaded object belongs to one row. Its key ends in the id of the
 * write that uploaded it, and it carries that row's key as `dynamodb-pk-b64` /
 * `dynamodb-sk-b64` user metadata. An object whose row is gone, is past its
 * `ttl`, or names another object is an orphan. Several things leave one:
 * - a write that may still land after failing — no answer, or DynamoDB
 *   answering `TransactionInProgressException` or a server error — keeps its
 *   upload;
 * - a best-effort delete fails;
 * - an exhausted compare-and-swap overwrites unconditionally.
 * With a `ttl`, the lifecycle rule `ensureS3LifecycleRule()` writes reclaims
 * them. Without one, nothing does, and this sweep is how they are found.
 *
 * What it reads, in order:
 * 1. `ListObjectsV2` under the prefix, paginated.
 * 2. For each object older than `--min-age-hours`, a `HeadObject` for its backlink.
 * 3. A strongly consistent `GetItem` on that key.
 * An object younger than the minimum age is never judged, because its row may
 * not be written yet: a write uploads first, and its retries stop 300 s in.
 *
 * Usage:
 *   node scripts/find-orphaned-payloads.mjs --bucket B --table T [--region R]
 *                                           [--prefix P] [--min-age-hours N] [--delete]
 *
 * Without `--delete` it writes nothing. With it, it deletes the orphans it
 * reported, in batches of up to 1000 keys. On a versioned bucket a delete
 * leaves a delete marker, so the object stays recoverable until the lifecycle
 * rule reclaims its noncurrent version.
 *
 * Exit code: 0 when the sweep completed, whether or not it found anything;
 * non-zero only when the sweep itself failed.
 *
 * Permissions: `s3:ListBucket` and `s3:GetObject` on the bucket, and
 * `dynamodb:GetItem` on the table. `--delete` also needs `s3:DeleteObject`.
 * These are the operator's permissions, not the application role's.
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

/** `--min-age-hours` as a number, refusing anything that is not a count of hours. */
function minAgeHoursOf(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`--min-age-hours must be a non-negative number of hours, not "${value}"`);
  }
  return hours;
}

/**
 * The sweep's settings, from `--flag value` or `--flag=value` pairs, and the
 * bare `--delete`.
 *
 * Throws when a flag is unknown or has no value, when `--delete` is given a
 * value, or when `--bucket` or `--table` is missing.
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
    parsed[field] = field === 'minAgeHours' ? minAgeHoursOf(value) : value;
  }
  if (parsed.bucket === undefined) throw new Error('--bucket is required');
  if (parsed.table === undefined) throw new Error('--table is required');
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
 * Why an object whose row was read is an orphan, or null when a live row still
 * names it. A row past its `ttl` is not live: every read of this package
 * treats it as absent, and DynamoDB deletes it within a few days.
 */
export function orphanReason(row, key, now = Date.now()) {
  if (row === null) return 'row-gone';
  if (typeof row.ttl === 'number' && row.ttl <= Math.floor(now / 1000)) return 'row-expired';
  if (!rowNamesKey(row, key)) return 'row-names-another-object';
  return null;
}

/** Each `ListObjectsV2` page's objects under `prefix`, handed to `onPage` in order. */
async function eachObjectPage(s3, { bucket, prefix }, onPage) {
  let token;
  for (;;) {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    await onPage(page.Contents ?? []);
    if (page.IsTruncated !== true) return;
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
      result.orphans.push({
        key: object.Key,
        pk: backlink.pk,
        sk: backlink.sk,
        reason,
        lastModified: new Date(lastModified),
        size: object.Size ?? 0,
      });
    }
  });
  return result;
}

/** Delete `orphans` in batches of up to 1000 keys; returns what S3 reported it could not delete. */
export async function deleteOrphans(s3, bucket, orphans) {
  const failed = [];
  for (let start = 0; start < orphans.length; start += DELETE_BATCH) {
    const batch = orphans.slice(start, start + DELETE_BATCH);
    const response = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((orphan) => ({ Key: orphan.key })), Quiet: true },
      }),
    );
    for (const error of response.Errors ?? []) {
      failed.push({ key: error.Key, reason: error.Code ?? 'DeleteObjects failed' });
    }
  }
  return failed;
}

/** One orphan, as one line an incident channel can carry. */
export function formatOrphan(orphan) {
  return [
    'ORPHAN',
    `objectKey=${orphan.key}`,
    `reason=${orphan.reason}`,
    `pk=${JSON.stringify(orphan.pk)}`,
    `sk=${JSON.stringify(orphan.sk)}`,
    `lastModified=${orphan.lastModified.toISOString()}`,
    `bytes=${orphan.size}`,
  ].join(' ');
}

/** The whole report: what was swept, what was found, and what was done with it. */
export function reportLines(result, deletion) {
  const lines = [
    `swept bucket=${result.bucket} prefix=${result.prefix} table=${result.table} ` +
      `minAgeHours=${result.minAgeHours}`,
    `listed ${result.objects} object(s) over ${result.pages} page(s): ${result.tooYoung} ` +
      `younger than the minimum age, ${result.checked} checked, ${result.live} named by a live row`,
  ];
  for (const row of result.unreadable) lines.push(`UNREADABLE objectKey=${row.key} reason=${row.reason}`);
  for (const orphan of result.orphans) lines.push(formatOrphan(orphan));
  const bytes = result.orphans.reduce((sum, orphan) => sum + orphan.size, 0);
  lines.push(`${result.orphans.length} orphaned object(s), ${bytes} byte(s)`);
  if (deletion === undefined) {
    if (result.orphans.length > 0) {
      lines.push('Nothing was deleted. Re-run with --delete to delete the orphans above.');
    }
    return lines;
  }
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
    const deletion = options.delete
      ? { failed: await deleteOrphans(s3, options.bucket, result.orphans) }
      : undefined;
    for (const line of reportLines(result, deletion)) console.log(line);
  } finally {
    s3.destroy();
    ddb.destroy();
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`sweep failed: ${error.message}`);
    process.exitCode = 1;
  });
}
