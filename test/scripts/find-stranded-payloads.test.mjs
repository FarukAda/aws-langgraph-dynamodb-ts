/**
 * Unit tests for the stranded-payload sweep (`scripts/find-stranded-payloads.mjs`),
 * run with `node --test` via `npm run test:scripts` because the script is an ESM
 * `.mjs` module and the jest tier transpiles CommonJS.
 *
 * Every client here is hand-rolled: an object with a `send` that answers on the
 * command's constructor name and records what it was asked. Nothing reaches AWS,
 * and a command the fake does not recognise throws, which is how the "repairs
 * nothing" assertion holds for every path rather than for the paths a test
 * happens to walk.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marshall } from '@aws-sdk/util-dynamodb';

import {
  addVersionsPage,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PREFIX,
  decodeBacklink,
  emptyListing,
  formatStranded,
  graceHoursRemaining,
  joinReleases,
  parseArgs,
  reportLines,
  rowNamesKey,
  sweep,
} from '../../scripts/find-stranded-payloads.mjs';

/** Base64url of `text`, the encoding the backlink metadata uses. */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** A joined listing built from whole pages, the way the sweep builds one. */
function listingOf(pages) {
  const listing = emptyListing();
  for (const page of pages) addVersionsPage(listing, page);
  return listing;
}

/**
 * An S3 stand-in. `pages` are served in order under the caller's
 * `KeyMarker`/`VersionIdMarker` continuation; `heads` maps `Key|VersionId` to a
 * `HeadObject` response, and an unmapped pair throws the way S3's 404 does.
 */
function fakeS3({ pages = [], heads = {} } = {}) {
  const sent = [];
  let page = 0;
  return {
    sent,
    names: () => sent.map((entry) => entry.name),
    send(command) {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name === 'ListObjectVersionsCommand') {
        const current = pages[page];
        page += 1;
        const last = page === pages.length;
        return Promise.resolve({
          Versions: current.Versions ?? [],
          DeleteMarkers: current.DeleteMarkers ?? [],
          IsTruncated: !last,
          NextKeyMarker: last ? undefined : `key-${page}`,
          NextVersionIdMarker: last ? undefined : `vid-${page}`,
        });
      }
      if (name === 'HeadObjectCommand') {
        const head = heads[`${command.input.Key}|${command.input.VersionId}`];
        if (head === undefined) {
          const error = new Error('NotFound');
          error.name = 'NotFound';
          return Promise.reject(error);
        }
        return Promise.resolve(head);
      }
      return Promise.reject(new Error(`unexpected S3 command: ${name}`));
    },
  };
}

/** A DynamoDB stand-in over plain items keyed by `pk|sk`. */
function fakeDynamo(items = {}) {
  const sent = [];
  return {
    sent,
    names: () => sent.map((entry) => entry.name),
    send(command) {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name !== 'GetItemCommand') {
        return Promise.reject(new Error(`unexpected DynamoDB command: ${name}`));
      }
      const item = items[`${command.input.Key.PK.S}|${command.input.Key.SK.S}`];
      return Promise.resolve(item === undefined ? {} : { Item: marshall(item) });
    },
  };
}

/** A descriptor as a row persists one: the offloaded location plus the object key. */
const offloaded = (s3Key) => ({ location: 'S3', s3Key, serdeType: 'json', compressed: false });

test('parseArgs takes the bucket and table and defaults the rest', () => {
  const parsed = parseArgs(['--bucket', 'b', '--table', 't']);
  assert.equal(parsed.bucket, 'b');
  assert.equal(parsed.table, 't');
  assert.equal(parsed.prefix, DEFAULT_PREFIX);
  assert.equal(parsed.graceDays, DEFAULT_GRACE_DAYS);
  assert.equal(parsed.region, undefined);
});

test('parseArgs honours every flag and refuses what it cannot answer for', () => {
  const parsed = parseArgs([
    '--bucket=b',
    '--table=t',
    '--region',
    'eu-west-1',
    '--prefix',
    'other/',
    '--grace-days',
    '3',
  ]);
  assert.deepEqual(parsed, {
    bucket: 'b',
    table: 't',
    region: 'eu-west-1',
    prefix: 'other/',
    graceDays: 3,
  });
  assert.throws(() => parseArgs(['--table', 't']), /--bucket/);
  assert.throws(() => parseArgs(['--bucket', 'b']), /--table/);
  assert.throws(() => parseArgs(['--bucket', 'b', '--table', 't', '--scan']), /--scan/);
  assert.throws(() => parseArgs(['--bucket', 'b', '--table', 't', '--grace-days', 'x']), /grace/);
});

test('the join pairs a marker with its own key, never with the version beside it', () => {
  /**
   * Three keys under the prefix; `p/a.bin` is still live, so it contributes two
   * entries to `Versions` and none to `DeleteMarkers`. A join by position pairs
   * the first marker (`p/b.bin`) with the first version (`p/a.bin`) and the
   * second marker (`p/c.bin`) with the second version (`p/a.bin` again), which
   * would send both `HeadObject` calls at a version id that is not theirs.
   */
  const page = {
    Versions: [
      { Key: 'p/a.bin', VersionId: 'a-new', IsLatest: true, LastModified: '2026-09-19T09:00:00Z' },
      { Key: 'p/a.bin', VersionId: 'a-old', IsLatest: false, LastModified: '2026-09-19T08:00:00Z' },
      { Key: 'p/b.bin', VersionId: 'b-1', IsLatest: false, LastModified: '2026-09-19T10:00:00Z' },
      { Key: 'p/c.bin', VersionId: 'c-1', IsLatest: false, LastModified: '2026-09-19T11:00:00Z' },
    ],
    DeleteMarkers: [
      { Key: 'p/b.bin', VersionId: 'b-mark', IsLatest: true, LastModified: '2026-09-19T12:00:00Z' },
      { Key: 'p/c.bin', VersionId: 'c-mark', IsLatest: true, LastModified: '2026-09-19T13:00:00Z' },
    ],
  };
  assert.deepEqual(
    joinReleases(listingOf([page])).map((release) => [
      release.key,
      release.markerVersionId,
      release.payloadVersionId,
    ]),
    [
      ['p/b.bin', 'b-mark', 'b-1'],
      ['p/c.bin', 'c-mark', 'c-1'],
    ],
  );
});

test('the join takes the newest surviving version for a key, not the first listed', () => {
  const page = {
    Versions: [
      { Key: 'p/d.bin', VersionId: 'd-old', IsLatest: false, LastModified: '2026-09-19T01:00:00Z' },
      { Key: 'p/d.bin', VersionId: 'd-new', IsLatest: false, LastModified: '2026-09-19T05:00:00Z' },
    ],
    DeleteMarkers: [
      { Key: 'p/d.bin', VersionId: 'd-mark', IsLatest: true, LastModified: '2026-09-19T06:00:00Z' },
    ],
  };
  assert.equal(joinReleases(listingOf([page]))[0].payloadVersionId, 'd-new');
});

test('the join carries a key across a page boundary, in either direction', () => {
  /**
   * Both arrays paginate together under one continuation pair, so a key's
   * marker and its surviving version can land on different pages. A join done
   * one page at a time sees a page of versions with no marker and a page of
   * markers with no version, and reports nothing at all.
   */
  const markerFirst = [
    {
      DeleteMarkers: [
        { Key: 'p/e.bin', VersionId: 'e-mark', IsLatest: true, LastModified: '2026-09-19T12:00:00Z' },
      ],
    },
    {
      Versions: [
        { Key: 'p/e.bin', VersionId: 'e-1', IsLatest: false, LastModified: '2026-09-19T11:00:00Z' },
      ],
    },
  ];
  const versionFirst = [markerFirst[1], markerFirst[0]];

  for (const pages of [markerFirst, versionFirst]) {
    const perPage = pages
      .flatMap((page) => joinReleases(listingOf([page])))
      .filter((release) => release.payloadVersionId !== null);
    assert.deepEqual(perPage, [], 'a per-page join pairs no payload with this marker');
    assert.deepEqual(
      joinReleases(listingOf(pages)).map((r) => [r.key, r.markerVersionId, r.payloadVersionId]),
      [['p/e.bin', 'e-mark', 'e-1']],
    );
  }
});

test('a marker whose last version has already expired joins to no payload', () => {
  const page = {
    DeleteMarkers: [
      { Key: 'p/f.bin', VersionId: 'f-mark', IsLatest: true, LastModified: '2026-09-01T00:00:00Z' },
    ],
  };
  assert.equal(joinReleases(listingOf([page]))[0].payloadVersionId, null);
});

test('graceHoursRemaining counts from the marker, and goes negative once spent', () => {
  const marker = new Date('2026-09-20T00:00:00Z');
  assert.equal(graceHoursRemaining(marker, 1, new Date('2026-09-20T06:00:00Z').getTime()), 18);
  assert.equal(graceHoursRemaining(marker, 1, new Date('2026-09-21T06:00:00Z').getTime()), -6);
});

test('decodeBacklink reads the two base64url metadata fields, or reports what is missing', () => {
  assert.deepEqual(
    decodeBacklink({ 'dynamodb-pk-b64': b64('CHKPT#t'), 'dynamodb-sk-b64': b64('PAYLOAD##c') }),
    { pk: 'CHKPT#t', sk: 'PAYLOAD##c' },
  );
  assert.equal(decodeBacklink({ 'dynamodb-pk-b64': b64('CHKPT#t') }), null);
  assert.equal(decodeBacklink(undefined), null);
});

test('rowNamesKey walks the whole row, whatever attribute holds the descriptor', () => {
  assert.equal(rowNamesKey({ checkpoint: offloaded('p/x.bin') }, 'p/x.bin'), true);
  assert.equal(rowNamesKey({ value: offloaded('p/y.bin') }, 'p/x.bin'), false);
  assert.equal(rowNamesKey({ metadata: { bytes: 'inline' } }, 'p/x.bin'), false);
  assert.equal(rowNamesKey({ nested: [{ deep: offloaded('p/x.bin') }] }, 'p/x.bin'), true);
});

/** The fixture every sweep test below runs against: four released keys, one strand. */
function sweepFixture() {
  const at = (key, suffix, time) => ({
    Key: key,
    VersionId: `${key}-${suffix}`,
    IsLatest: false,
    LastModified: time,
  });
  const marker = (key) => ({
    Key: key,
    VersionId: `${key}-mark`,
    IsLatest: true,
    LastModified: '2026-09-20T00:00:00Z',
  });
  const keys = ['p/live.bin', 'p/gone.bin', 'p/super.bin', 'p/nometa.bin'];
  /**
   * `p/alive.bin` was never released, so it contributes a version and no
   * marker. It is what makes the two arrays non-parallel, and what turns a
   * join by position into wrong `HeadObject` calls rather than lucky ones.
   */
  const alive = { ...at('p/alive.bin', 'v1', '2026-09-19T22:00:00Z'), IsLatest: true };
  const pages = [
    {
      Versions: [alive, ...keys.map((key) => at(key, 'v1', '2026-09-19T23:00:00Z'))],
      DeleteMarkers: keys.map(marker),
    },
  ];
  const meta = (pk, sk) => ({ Metadata: { 'dynamodb-pk-b64': b64(pk), 'dynamodb-sk-b64': b64(sk) } });
  const heads = {
    'p/live.bin|p/live.bin-v1': meta('CHKPT#t1', 'PAYLOAD##c1'),
    'p/gone.bin|p/gone.bin-v1': meta('CHKPT#t2', 'PAYLOAD##c2'),
    'p/super.bin|p/super.bin-v1': meta('STORE#ns', 'k3'),
    'p/nometa.bin|p/nometa.bin-v1': { Metadata: {} },
  };
  const items = {
    'CHKPT#t1|PAYLOAD##c1': { PK: 'CHKPT#t1', SK: 'PAYLOAD##c1', checkpoint: offloaded('p/live.bin') },
    'STORE#ns|k3': { PK: 'STORE#ns', SK: 'k3', value: offloaded('p/newer.bin') },
  };
  return { pages, heads, items };
}

/** The sweep over {@link sweepFixture}, at a fixed `now` six hours into the grace. */
async function runSweep() {
  const { pages, heads, items } = sweepFixture();
  const s3 = fakeS3({ pages, heads });
  const ddb = fakeDynamo(items);
  const result = await sweep({
    s3,
    ddb,
    bucket: 'bkt',
    table: 'tbl',
    prefix: 'p/',
    graceDays: 1,
    now: new Date('2026-09-20T06:00:00Z').getTime(),
  });
  return { result, s3, ddb };
}

test('a live row that still names the released key is the only one reported', async () => {
  const { result } = await runSweep();
  assert.deepEqual(
    result.stranded.map((row) => [row.pk, row.sk, row.key]),
    [['CHKPT#t1', 'PAYLOAD##c1', 'p/live.bin']],
  );
  assert.equal(result.markers, 4);
  assert.equal(result.checked, 4);
});

test('the report line carries the row key, object key, version, marker time and grace left', async () => {
  const { result } = await runSweep();
  const line = formatStranded(result.stranded[0]);
  for (const part of [
    'CHKPT#t1',
    'PAYLOAD##c1',
    'p/live.bin',
    'p/live.bin-v1',
    '2026-09-20T00:00:00.000Z',
    '18',
  ]) {
    assert.ok(line.includes(part), `report line is missing ${part}: ${line}`);
  }
});

test('HeadObject is asked for the payload version, and GetItem reads consistently', async () => {
  const { s3, ddb } = await runSweep();
  const heads = s3.sent.filter((entry) => entry.name === 'HeadObjectCommand');
  assert.deepEqual(
    heads.map((entry) => entry.input.VersionId),
    ['p/live.bin-v1', 'p/gone.bin-v1', 'p/super.bin-v1', 'p/nometa.bin-v1'],
  );
  assert.ok(ddb.sent.every((entry) => entry.input.ConsistentRead === true));
});

test('a row that is gone, and one that now names another object, are both left out', async () => {
  const { result, ddb } = await runSweep();
  const read = ddb.sent.map((entry) => `${entry.input.Key.PK.S}|${entry.input.Key.SK.S}`);
  assert.ok(read.includes('CHKPT#t2|PAYLOAD##c2'), 'the released row must be looked up');
  assert.ok(read.includes('STORE#ns|k3'), 'the superseded row must be looked up');
  assert.equal(result.stranded.length, 1);
});

test('an object without the backlink metadata is reported unreadable and the sweep goes on', async () => {
  const { result } = await runSweep();
  assert.deepEqual(
    result.unreadable.map((row) => row.key),
    ['p/nometa.bin'],
  );
  assert.equal(result.stranded.length, 1);
});

test('nothing is ever repaired: only the three reading commands are sent', async () => {
  const { s3, ddb } = await runSweep();
  assert.deepEqual(new Set(s3.names()), new Set(['ListObjectVersionsCommand', 'HeadObjectCommand']));
  assert.deepEqual(new Set(ddb.names()), new Set(['GetItemCommand']));
  const mutating = /^(Delete|Put|Copy|Write|Update|Restore|Transact|Batch)/;
  for (const entry of [...s3.sent, ...ddb.sent]) {
    assert.ok(!mutating.test(entry.name), `the sweep sent a mutating command: ${entry.name}`);
  }
});

test('the sweep paginates, carrying the key and version markers it was handed', async () => {
  const pages = [
    {
      DeleteMarkers: [
        { Key: 'p/e.bin', VersionId: 'e-mark', IsLatest: true, LastModified: '2026-09-20T00:00:00Z' },
      ],
    },
    {
      Versions: [
        { Key: 'p/e.bin', VersionId: 'e-1', IsLatest: false, LastModified: '2026-09-19T23:00:00Z' },
      ],
    },
  ];
  const s3 = fakeS3({
    pages,
    heads: {
      'p/e.bin|e-1': { Metadata: { 'dynamodb-pk-b64': b64('HIST#s'), 'dynamodb-sk-b64': b64('M#1') } },
    },
  });
  const ddb = fakeDynamo({ 'HIST#s|M#1': { PK: 'HIST#s', SK: 'M#1', message: offloaded('p/e.bin') } });
  const result = await sweep({
    s3,
    ddb,
    bucket: 'bkt',
    table: 'tbl',
    prefix: 'p/',
    graceDays: 1,
    now: new Date('2026-09-20T06:00:00Z').getTime(),
  });
  const lists = s3.sent.filter((entry) => entry.name === 'ListObjectVersionsCommand');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].input.Prefix, 'p/');
  assert.equal(lists[0].input.KeyMarker, undefined);
  assert.equal(lists[1].input.KeyMarker, 'key-1');
  assert.equal(lists[1].input.VersionIdMarker, 'vid-1');
  assert.equal(result.pages, 2);
  assert.deepEqual(
    result.stranded.map((row) => row.key),
    ['p/e.bin'],
  );
});

test('the report names both remedies and repairs neither', async () => {
  const { result } = await runSweep();
  const text = reportLines(result).join('\n');
  assert.match(text, /DeleteObjectVersion/);
  assert.match(text, /delete marker/i);
  assert.match(text, /DeleteItem/);
  assert.match(text, /p\/live\.bin-mark/, 'the marker version id the restore needs must be printed');
});

test('a sweep that finds nothing still reports what it swept', async () => {
  const s3 = fakeS3({ pages: [{}] });
  const ddb = fakeDynamo();
  const result = await sweep({ s3, ddb, bucket: 'bkt', table: 'tbl', prefix: 'p/', graceDays: 1 });
  assert.deepEqual(result.stranded, []);
  assert.match(reportLines(result).join('\n'), /bkt/);
  assert.equal(ddb.sent.length, 0);
});
