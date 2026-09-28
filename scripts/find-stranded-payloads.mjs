/**
 * Report DynamoDB rows whose offloaded S3 payload has been released.
 *
 * A release on a versioned bucket does not erase the object: it leaves a delete
 * marker with the payload surviving behind it as a noncurrent version, until the
 * lifecycle rule's grace expires. That window is the only time a stranded row —
 * one still live, still naming an object whose payload was released — can be
 * found cheaply, because the object side lists exactly the releases and each
 * object carries its row's key as `dynamodb-pk-b64` / `dynamodb-sk-b64` user
 * metadata.
 *
 * What it reads, in order: `ListObjectVersions` under the prefix, paginated;
 * for each released key, `HeadObject` on the surviving payload version to read
 * that backlink; then a strongly-consistent `GetItem` on the decoded key, and —
 * only for a checkpoint PAYLOAD or WRITE row that read finds past its own
 * `ttl` — one further strongly-consistent `GetItem` on that checkpoint's META
 * row. It writes nothing and repairs nothing — it prints the two remedies and
 * leaves the choice to an operator, because the right one depends on why the
 * row is there.
 *
 * A row past its `ttl` is not always gone to every reader, so it is not always
 * left out of the report. A checkpoint META row, a store item row and a
 * history message row are: `getTuple`, `list`, `store.get`/`search` and
 * `history.getMessages` each check a row's own `ttl` before serving it, so one
 * of those past its `ttl` is ordinary expiry, counted apart rather than
 * reported. A checkpoint PAYLOAD row and every pending-WRITE row are not:
 * `getTuple`/`list` serve those once the checkpoint's META row is judged live,
 * without ever checking the PAYLOAD or WRITE row's own `ttl` — and a WRITE row
 * stamps its own `ttl` independently when `putWrites` runs, so it can expire
 * while its checkpoint's META row is still live and served. One of those past
 * its own `ttl` is therefore still reported as stranded, unless its
 * checkpoint's META row is itself past its `ttl` or absent — which the one
 * extra `GetItem` above decides. A row whose kind this script cannot place, or
 * whose META row it cannot read, is reported rather than guessed at: a false
 * report is safer than a hidden broken checkpoint.
 *
 * Usage:
 *   node scripts/find-stranded-payloads.mjs --bucket B --table T [--region R]
 *                                           [--prefix P] [--grace-days N]
 *
 * Exit code: 0 when the sweep completed, whether or not it found anything;
 * non-zero only when the sweep itself failed.
 *
 * The operator running it needs `s3:ListBucketVersions`, `s3:GetObjectVersion`
 * and `dynamodb:GetItem` — the first two are not actions the library itself ever
 * calls. See the README runbook.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { HeadObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { isMain } from './is-main.mjs';

/**
 * The key prefix swept when none is given. It mirrors `DEFAULT_S3_KEY_PREFIX`
 * in `src/shared/codec/s3/config.ts`, and a static test pins the two together.
 */
export const DEFAULT_PREFIX = 'langgraph-checkpoints/';

/**
 * Days a released payload survives behind its delete marker. It mirrors
 * `S3_RELEASE_GRACE_DAYS` in `src/shared/codec/s3/lifecycle.ts` — the value
 * `ensureS3LifecycleRule()` writes as `NoncurrentDays` — and a static test pins
 * the two together. Pass `--grace-days` when the bucket carries a longer floor.
 */
export const DEFAULT_GRACE_DAYS = 1;

/**
 * How long one of this script's requests may run, and how long it may sit idle
 * mid-response. They mirror `DEFAULT_REQUEST_TIMEOUT_MS` and
 * `DEFAULT_SOCKET_TIMEOUT_MS` in `src/shared/dynamodb/client.ts` — the bounds
 * the library's own clients carry — and a static test pins each pair together.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/** The metadata names carrying the backlink. S3 lower-cases them; both are base64url. */
const PK_FIELD = 'dynamodb-pk-b64';
const SK_FIELD = 'dynamodb-sk-b64';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Each accepted flag and the field it fills. */
const FLAGS = {
  '--bucket': 'bucket',
  '--table': 'table',
  '--region': 'region',
  '--prefix': 'prefix',
  '--grace-days': 'graceDays',
};

/** `--flag=value` split into its two halves; a bare `--flag` yields no value. */
function splitFlag(argument) {
  const equals = argument.indexOf('=');
  if (equals < 0) return [argument, undefined];
  return [argument.slice(0, equals), argument.slice(equals + 1)];
}

/** `--grace-days` as a number, refusing anything that is not a count of days. */
function graceDaysOf(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--grace-days must be a non-negative number of days, not "${value}"`);
  }
  return days;
}

/**
 * The sweep's settings, from `--flag value` or `--flag=value` pairs.
 *
 * Throws when a flag is unknown, has no value, or when `--bucket` or `--table`
 * is missing: the sweep has nothing to read without them.
 */
export function parseArgs(argv) {
  const parsed = {
    bucket: undefined,
    table: undefined,
    region: undefined,
    prefix: DEFAULT_PREFIX,
    graceDays: DEFAULT_GRACE_DAYS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = splitFlag(argv[index]);
    const field = FLAGS[flag];
    if (field === undefined) {
      throw new Error(`unknown argument "${flag}"; accepted: ${Object.keys(FLAGS).join(' ')}`);
    }
    let value = inline;
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined) throw new Error(`"${flag}" needs a value`);
    parsed[field] = field === 'graceDays' ? graceDaysOf(value) : value;
  }
  if (parsed.bucket === undefined) throw new Error('--bucket is required');
  if (parsed.table === undefined) throw new Error('--table is required');
  return parsed;
}

/**
 * A streaming join across the paginated listing, holding one key at a time.
 *
 * `ListObjectVersions` answers in ascending key order, with every entry for a
 * key — versions and delete markers alike — adjacent and newest first, and
 * `KeyMarker`/`VersionIdMarker` resume at a position in that same order
 * ("NextKeyMarker specifies the first key not returned"). A key is therefore
 * complete the moment a later key appears, so the join never needs the whole
 * listing: it holds the open key's entries and the last key it closed. That
 * matters because this sweep is run after an incident, and on a bucket without
 * the marker-reclaim rule the marker set has no upper bound — the one moment at
 * which a tool holding the entire listing would run out of memory.
 *
 * The ordering is checked, not trusted: a key opening at or below the last one
 * closed fails the sweep. It costs one comparison and one retained key, and it
 * catches a key reappearing after it was closed as well as any other break in
 * the order.
 *
 * `onRelease` is called once per released key, in listing order.
 */
export function emptyJoin(onRelease) {
  return { pages: 0, versions: 0, markers: 0, open: null, lastClosedKey: null, onRelease };
}

/** One listing entry reduced to what the join needs. */
function normalise(entry) {
  return {
    versionId: entry.VersionId,
    isLatest: entry.IsLatest === true,
    lastModified: new Date(entry.LastModified),
  };
}

/**
 * The newest of `entries`, or undefined for none. Ties on `LastModified` are
 * broken by the greater version id, so the choice is the same on every run.
 */
function pickNewest(entries) {
  let best;
  for (const entry of entries) {
    if (best === undefined) {
      best = entry;
      continue;
    }
    const delta = entry.lastModified.getTime() - best.lastModified.getTime();
    if (delta > 0 || (delta === 0 && entry.versionId > best.versionId)) best = entry;
  }
  return best;
}

/**
 * One key's entries as a release, or null when that key was not released.
 *
 * A key is released exactly when its **current** entry is a delete marker. A
 * key carrying a marker further down its history was written again after that
 * release — the same object id re-landing, or a legacy store key with no
 * per-write segment, rewritten in place — so its payload is current and
 * readable. Calling that stranded would hand an operator a `DeleteItem` on a
 * healthy row.
 *
 * The marker's `VersionId` is the marker's own, not the payload's: heading that
 * version reads the marker and returns a 404 with no metadata. The payload is
 * the newest entry in `Versions` for this key that is not the current one,
 * which is not the same as the first entry listed for it.
 *
 * `payloadVersionId` is null when the key has a marker but no surviving
 * version: its grace is spent and there is nothing left to read a backlink
 * from.
 */
function releaseOf({ key, versions, markers }) {
  const marker = markers.find((entry) => entry.isLatest);
  if (marker === undefined) return null;
  const payload = pickNewest(versions.filter((version) => !version.isLatest));
  return {
    key,
    markerVersionId: marker.versionId,
    markerLastModified: marker.lastModified,
    payloadVersionId: payload === undefined ? null : payload.versionId,
    payloadLastModified: payload === undefined ? null : payload.lastModified,
  };
}

/** Close the open key, emitting its release if it had one. */
function closeOpenKey(join) {
  const open = join.open;
  if (open === null) return;
  join.open = null;
  join.lastClosedKey = open.key;
  const release = releaseOf(open);
  if (release !== null) join.onRelease(release);
}

/** The slot for `key`, closing the previous one and checking the listing's order. */
function openKey(join, key) {
  if (join.open !== null && join.open.key === key) return join.open;
  closeOpenKey(join);
  if (join.lastClosedKey !== null && key <= join.lastClosedKey) {
    throw new Error(
      `S3 listed key "${key}" after "${join.lastClosedKey}" had been closed; ` +
        'ListObjectVersions answers in ascending key order and this listing does not, ' +
        'so one key may have been split in two and the join cannot be trusted',
    );
  }
  join.open = { key, versions: [], markers: [] };
  return join.open;
}

/**
 * Fold one `ListObjectVersions` page into `join`.
 *
 * `Versions` and `DeleteMarkers` are two arrays split out of one ordered
 * stream, so they are merged back into key order here — at most 1000 entries,
 * the page's own cap — before being fed to the join one key at a time. A key
 * whose marker and payload straddle a page boundary stays open across it and is
 * joined when it closes; a join done page by page would report neither half.
 */
export function addVersionsPage(join, page) {
  join.pages += 1;
  const entries = [];
  for (const version of page.Versions ?? []) {
    entries.push({ key: version.Key, kind: 'versions', entry: normalise(version) });
    join.versions += 1;
  }
  for (const marker of page.DeleteMarkers ?? []) {
    entries.push({ key: marker.Key, kind: 'markers', entry: normalise(marker) });
    join.markers += 1;
  }
  entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  for (const { key, kind, entry } of entries) openKey(join, key)[kind].push(entry);
  return join;
}

/** Close the last open key, once the listing has no more pages. */
export function finishJoin(join) {
  closeOpenKey(join);
  return join;
}

/**
 * Every release in `pages`, collected. The sweep uses the streaming form; this
 * is for a caller that already holds a whole listing, and for the tests.
 */
export function joinReleases(pages) {
  const releases = [];
  const join = emptyJoin((release) => releases.push(release));
  for (const page of pages) addVersionsPage(join, page);
  finishJoin(join);
  return releases;
}

/**
 * Hours left before S3 reclaims the surviving version, counted from the delete
 * marker — the moment the payload became noncurrent. Negative once spent; S3's
 * day granularity rounds the real deadline up to the next UTC midnight, so this
 * is the pessimistic end of a 24-48 h window.
 */
export function graceHoursRemaining(markerLastModified, graceDays, now = Date.now()) {
  const expiresAt = markerLastModified.getTime() + graceDays * DAY_MS;
  return Math.round(((expiresAt - now) / HOUR_MS) * 10) / 10;
}

/**
 * One base64url metadata value as the text it encodes, or null when the value
 * is not the base64url of anything usable.
 *
 * Node's base64 decoder drops characters outside the alphabet rather than
 * throwing, so a malformed value decodes to something instead of to an error;
 * re-encoding is what tells a real backlink from a garbage one. The empty
 * result matters most: DynamoDB refuses an empty key attribute outright, so
 * letting one through would end the whole sweep on a `ValidationException`
 * rather than skip one unreadable object.
 */
function decodePart(value) {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  if (text.length === 0) return null;
  return Buffer.from(text, 'utf8').toString('base64url') === value ? text : null;
}

/**
 * The DynamoDB key an object's user metadata points back at, or null when the
 * pair is not both present and both readable — an object written by something
 * else, a version that is not a payload at all, or metadata mangled since it
 * was written.
 */
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

/**
 * Whether an unmarshalled row still references `s3Key`.
 *
 * A row can carry more than one payload descriptor, under attributes that
 * differ by row kind (`checkpoint`, `metadata`, `value`, `message`), so the
 * whole item is walked for any object that is offloaded and names this key.
 * A row that has since been rewritten to name another object is not stranded;
 * it was superseded.
 */
export function rowNamesKey(item, s3Key) {
  if (item === null || typeof item !== 'object') return false;
  if (!Array.isArray(item) && item.location === 'S3' && item.s3Key === s3Key) return true;
  return Object.values(item).some((value) => rowNamesKey(value, s3Key));
}

/**
 * Whether a row is past its `ttl`. Every read of this package treats such a
 * row as absent, and DynamoDB deletes it within a few days — but that is only
 * true of *some* row kinds here; see {@link classifyRow} and the module
 * header for which, and why a checkpoint PAYLOAD or WRITE row is not one of
 * them.
 */
export function isExpiredRow(row, now = Date.now()) {
  return typeof row.ttl === 'number' && row.ttl <= Math.floor(now / 1000);
}

/**
 * Partition-key and sort-key tags {@link classifyRow} needs to tell one row
 * kind from another. They are the same tags `ADAPTER_TAGS` and
 * `KEY_SEPARATOR` in `src/shared/dynamodb/table-schema.ts`, the checkpointer's
 * own `META#`/`PAYLOAD#`/`WRITE#` sort-key tags in
 * `src/checkpointer/internal/rows.ts`, and the `HISTORY#MSG#` tag in
 * `src/history/internal/rows.ts` compose every row's key from — copied here
 * as literals, the way this file already mirrors `DEFAULT_S3_KEY_PREFIX` and
 * `S3_RELEASE_GRACE_DAYS`, because this script does not import from `src`.
 */
const CHECKPOINTER_PARTITION_PREFIX = 'CHKPT#';
const STORE_PARTITION_PREFIX = 'STORE#';
const HISTORY_PARTITION_PREFIX = 'HIST#';
const META_SORT_PREFIX = 'META#';
const PAYLOAD_SORT_PREFIX = 'PAYLOAD#';
const WRITE_SORT_PREFIX = 'WRITE#';
const HISTORY_MESSAGE_SORT_PREFIX = 'HISTORY#MSG#';

/**
 * A checkpoint META row's key, composed from a PAYLOAD or WRITE candidate's
 * own `SK`. Both kinds carry their checkpoint's namespace and id in exactly
 * the same two segments, right after the row-kind tag — `PAYLOAD#<ns>#<id>`
 * and `WRITE#<ns>#<id>#<taskId>#<index>#<channel>` — which is the one thing
 * this function trusts: neither row kind carries `checkpointNs`/
 * `checkpointId` as its own attribute, so the key is the only place to read
 * them from. Returns null for a sort key with fewer segments than a real one
 * ever has, rather than compose a key that cannot be right.
 */
function checkpointMetaKeyOf(row) {
  const segments = row.SK.split('#');
  if (segments.length < 3) return null;
  return { PK: row.PK, SK: `${META_SORT_PREFIX}${segments[1]}#${segments[2]}` };
}

/**
 * What this sweep can tell about a row that names a released key, for judging
 * whether its own expired `ttl` actually hides it from every reader.
 *
 * `'self-gated'`: a checkpoint META row, a store item row or a history
 * message row. Every read of this package already treats one of these as
 * absent once its own `ttl` passes.
 *
 * `'meta-gated'`: a checkpoint PAYLOAD row or a pending-WRITE row, carrying
 * the key of its checkpoint's META row. `getTuple`/`list` serve one of these
 * once the checkpoint's META row is judged live, without ever checking the
 * PAYLOAD or WRITE row's own `ttl` — so one past its own `ttl` is hidden only
 * when its META row is itself past its `ttl` or absent.
 *
 * `'unrecognised'`: neither — a row shape this script does not know, or a
 * PAYLOAD/WRITE row whose sort key is too short to carry a checkpoint id.
 * Never treated as hidden: this script would be guessing.
 */
function classifyRow(row) {
  const pk = typeof row.PK === 'string' ? row.PK : '';
  const sk = typeof row.SK === 'string' ? row.SK : '';
  if (pk.startsWith(STORE_PARTITION_PREFIX)) return { kind: 'self-gated' };
  if (pk.startsWith(HISTORY_PARTITION_PREFIX)) {
    return sk.startsWith(HISTORY_MESSAGE_SORT_PREFIX)
      ? { kind: 'self-gated' }
      : { kind: 'unrecognised' };
  }
  if (pk.startsWith(CHECKPOINTER_PARTITION_PREFIX)) {
    if (sk.startsWith(META_SORT_PREFIX)) return { kind: 'self-gated' };
    if (sk.startsWith(PAYLOAD_SORT_PREFIX) || sk.startsWith(WRITE_SORT_PREFIX)) {
      const metaKey = checkpointMetaKeyOf(row);
      return metaKey === null ? { kind: 'unrecognised' } : { kind: 'meta-gated', metaKey };
    }
    return { kind: 'unrecognised' };
  }
  return { kind: 'unrecognised' };
}

/** Each `ListObjectVersions` page under `prefix`, handed to `onPage` in order. */
async function eachListingPage(s3, { bucket, prefix }, onPage) {
  let keyMarker;
  let versionIdMarker;
  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    await onPage(page);
    if (page.IsTruncated !== true) return;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
}

/**
 * The backlink on one released key's surviving payload version, or null with
 * the reason recorded. A version that cannot be read is reported rather than
 * thrown: one unreadable object must not end the sweep.
 */
async function readBacklink(s3, bucket, release, result) {
  const record = { key: release.key, versionId: release.payloadVersionId };
  try {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: release.key,
        VersionId: release.payloadVersionId,
      }),
    );
    const backlink = decodeBacklink(head.Metadata);
    if (backlink !== null) return backlink;
    result.unreadable.push({
      ...record,
      reason: `no readable ${PK_FIELD} / ${SK_FIELD} pair on this version`,
    });
  } catch (error) {
    result.unreadable.push({ ...record, reason: error.name ?? 'HeadObject failed' });
  }
  return null;
}

/**
 * The row at `(pk, sk)`, read consistently: the item, null when there is none,
 * or undefined with the reason recorded when the read itself failed. A
 * throttled or refused row read must not end a sweep that has already found
 * something and still has keys to check.
 */
async function readRow(ddb, { table, pk, sk }, release, result) {
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
    const name = error.name ?? 'unknown error';
    result.unreadable.push({
      key: release.key,
      versionId: release.payloadVersionId,
      reason: `GetItem pk=${JSON.stringify(pk)} sk=${JSON.stringify(sk)} failed: ${name}`,
    });
    return undefined;
  }
}

/**
 * A checkpoint PAYLOAD or WRITE candidate's own checkpoint META row, read
 * consistently: the row, null when there is none, or undefined with the
 * reason recorded when the read itself failed. The same shape as
 * {@link readRow}, kept separate so a failed read is reported against the
 * META key it actually queried, not the candidate's own key.
 */
async function readCheckpointMeta(ddb, table, metaKey, release, result) {
  try {
    const response = await ddb.send(
      new GetItemCommand({
        TableName: table,
        Key: { PK: { S: metaKey.PK }, SK: { S: metaKey.SK } },
        ConsistentRead: true,
      }),
    );
    return response.Item === undefined ? null : unmarshall(response.Item);
  } catch (error) {
    const name = error.name ?? 'unknown error';
    result.unreadable.push({
      key: release.key,
      versionId: release.payloadVersionId,
      reason:
        `GetItem on this row's checkpoint META pk=${JSON.stringify(metaKey.PK)} ` +
        `sk=${JSON.stringify(metaKey.SK)} failed: ${name}`,
    });
    return undefined;
  }
}

/**
 * Whether a row already confirmed to name the released key, and already found
 * past its own `ttl`, is genuinely hidden from every reader — the only case
 * this sweep may count apart rather than report (see the module header for
 * the rule this implements).
 *
 * Called only for a candidate that would otherwise be reported, so the one
 * extra `GetItem` a 'meta-gated' row costs is rare by construction. A row
 * this script cannot classify, and a 'meta-gated' row whose META read itself
 * fails, both answer false — reported, not skipped — because a false report
 * is safer than a hidden broken checkpoint.
 */
async function rowHiddenByTtl(ddb, table, row, release, result, now) {
  const classified = classifyRow(row);
  if (classified.kind === 'self-gated') return true;
  if (classified.kind === 'unrecognised') return false;
  const meta = await readCheckpointMeta(ddb, table, classified.metaKey, release, result);
  if (meta === undefined) return false;
  return meta === null || isExpiredRow(meta, now);
}

/**
 * Sweep one prefix and report the rows whose payload was released.
 *
 * Reads only. `s3` and `ddb` are anything with a `send`, so the whole sweep is
 * driven by fakes in the tests. Each release is inspected as the listing closes
 * its key, so nothing proportional to the bucket is ever held: only the open
 * key, the releases one page closed, and the findings themselves. A checkpoint
 * PAYLOAD or WRITE candidate already past its own `ttl` costs one further
 * `GetItem`, on its checkpoint's META row — the one row kind whose own `ttl`
 * does not already settle it; see {@link rowHiddenByTtl}.
 */
export async function sweep({ s3, ddb, bucket, table, prefix, graceDays, now = Date.now() }) {
  const result = {
    bucket,
    table,
    prefix,
    graceDays,
    pages: 0,
    versions: 0,
    markers: 0,
    releases: 0,
    expired: 0,
    checked: 0,
    expiredRows: 0,
    unreadable: [],
    stranded: [],
  };
  const inspect = async (release) => {
    result.releases += 1;
    if (release.payloadVersionId === null) {
      result.expired += 1;
      return;
    }
    result.checked += 1;
    const backlink = await readBacklink(s3, bucket, release, result);
    if (backlink === null) return;
    const row = await readRow(ddb, { table, ...backlink }, release, result);
    if (row === null || row === undefined || !rowNamesKey(row, release.key)) return;
    if (isExpiredRow(row, now) && (await rowHiddenByTtl(ddb, table, row, release, result, now))) {
      result.expiredRows += 1;
      return;
    }
    result.stranded.push({
      pk: backlink.pk,
      sk: backlink.sk,
      key: release.key,
      payloadVersionId: release.payloadVersionId,
      markerVersionId: release.markerVersionId,
      markerLastModified: release.markerLastModified,
      graceHoursRemaining: graceHoursRemaining(release.markerLastModified, graceDays, now),
    });
  };
  const pending = [];
  const join = emptyJoin((release) => pending.push(release));
  const drain = async () => {
    while (pending.length > 0) await inspect(pending.shift());
  };
  await eachListingPage(s3, { bucket, prefix }, async (page) => {
    addVersionsPage(join, page);
    await drain();
  });
  finishJoin(join);
  await drain();
  result.pages = join.pages;
  result.versions = join.versions;
  result.markers = join.markers;
  return result;
}

/** One stranded row, as one line an incident channel can carry. */
export function formatStranded(row) {
  return [
    'STRANDED',
    `pk=${JSON.stringify(row.pk)}`,
    `sk=${JSON.stringify(row.sk)}`,
    `objectKey=${row.key}`,
    `payloadVersionId=${row.payloadVersionId}`,
    `deleteMarkerVersionId=${row.markerVersionId}`,
    `markerLastModified=${row.markerLastModified.toISOString()}`,
    `graceHoursRemaining=${row.graceHoursRemaining}`,
  ].join(' ');
}

/** The two remedies, printed after any finding. This script applies neither. */
const REMEDIES = [
  'This script repairs nothing. Each row above has two remedies, and which one is',
  'right depends on why the row is still there:',
  '  (a) restore the payload - DeleteObjectVersion on the delete marker, the id',
  '      printed above as deleteMarkerVersionId, which makes the payload current',
  '      again. Do this while graceHoursRemaining is still positive.',
  '  (b) accept the delete - DeleteItem on the DynamoDB key printed above (pk, sk).',
  'For a checkpointer WRITE row that survived a deleteThread, (b) is right; for a',
  'store item that was recreated after its object was released, it is not.',
];

/** The whole report: what was swept, what was found, and what to do with it. */
export function reportLines(result) {
  const lines = [
    `swept bucket=${result.bucket} prefix=${result.prefix} table=${result.table} ` +
      `graceDays=${result.graceDays}`,
    `listed ${result.versions} version(s) and ${result.markers} delete marker(s) ` +
      `over ${result.pages} page(s)`,
    `${result.releases} released key(s): ${result.checked} checked, ` +
      `${result.expired} with no surviving payload version, ` +
      `${result.expiredRows} past their ttl and already hidden from every reader`,
  ];
  for (const row of result.unreadable) {
    lines.push(
      `UNREADABLE objectKey=${row.key} payloadVersionId=${row.versionId} reason=${row.reason}`,
    );
  }
  for (const row of result.stranded) lines.push(formatStranded(row));
  lines.push(`${result.stranded.length} stranded row(s)`);
  if (result.stranded.length > 0) lines.push(...REMEDIES);
  return lines;
}

/**
 * The config both clients are built from: a request handler that bounds how
 * long a request may run, under whatever the caller set.
 *
 * The shape differs from the library's own clients in three ways, each of them
 * deliberate, because what this script sends is not what the library sends.
 *
 * It carries a `requestTimeout` where the library's S3 client deliberately
 * carries none. There, a `PutObject`'s response headers arrive only once the
 * whole body has been uploaded, so a bound on the request would be a bound on
 * the upload and would destroy a legitimate large one for being slow. This
 * script sends `ListObjectVersions`, `HeadObject` and `GetItem` and nothing
 * else, all small, so the timer bounds a request rather than a transfer.
 * `throwOnRequestTimeout` is what makes it a bound at all — without it the
 * handler only warns — and `socketTimeout` covers what a request timeout
 * cannot, a response that stalls after its headers have arrived.
 *
 * It sets no `maxAttempts`, where the library pins it to 1. The library pins
 * it because it has a retry layer of its own and stacking the two multiplies
 * the budget. This script has no retry layer, so the SDK's own retries are the
 * only ones it gets and they have to stay: take them away and one throttled
 * `GetItem` becomes an unreadable row in the report.
 *
 * It passes no `connectionTimeout`, for the reason the library refuses one:
 * that timer counts the wait behind the agent's sockets, and this script
 * issues a `HeadObject` and a `GetItem` for every released key, so it queues
 * by design.
 *
 * `clientConfig` is spread last, so anything a caller sets — a
 * `requestHandler` above all — replaces this one whole rather than merging
 * into it.
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

/** The real constructors: what the script builds its clients with when it runs. */
const realS3 = (config) => new S3Client(config);
const realDynamoDB = (config) => new DynamoDBClient(config);

/**
 * Parse, announce what is about to be swept, sweep it, print the report.
 *
 * `createS3` and `createDynamoDB` default to the real constructors and are
 * here only so a test can read the config a client was built with. They take
 * no flag and change nothing on the command line.
 */
export async function main(argv, { createS3 = realS3, createDynamoDB = realDynamoDB } = {}) {
  const options = parseArgs(argv);
  const clientConfig = options.region === undefined ? {} : { region: options.region };
  console.log(
    `sweeping bucket=${options.bucket} prefix=${options.prefix} table=${options.table} ` +
      `region=${options.region ?? '(from the environment)'} graceDays=${options.graceDays}`,
  );
  const s3 = createS3(boundedClientConfig(clientConfig));
  const ddb = createDynamoDB(boundedClientConfig(clientConfig));
  try {
    const result = await sweep({ s3, ddb, ...options });
    for (const line of reportLines(result)) console.log(line);
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
