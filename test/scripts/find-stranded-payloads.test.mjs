/**
 * Unit tests for the stranded-payload sweep (`scripts/find-stranded-payloads.mjs`),
 * run with `node --test` via `npm run test:scripts` because the script is an ESM
 * `.mjs` module and the jest tier transpiles CommonJS.
 *
 * Every client here is hand-rolled: an object with a `send` that answers on the
 * command's constructor name and records what it was asked. Nothing reaches AWS,
 * and a command the fake does not recognise throws.
 *
 * {@link sweepFixture} deliberately walks every branch of the sweep — stranded,
 * gone, superseded, rewritten, unreadable three ways, and a marker with no
 * surviving version — because an assertion over the commands a sweep sent is
 * only worth the paths that sweep took.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marshall } from '@aws-sdk/util-dynamodb';

import {
  addVersionsPage,
  boundedClientConfig,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PREFIX,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  decodeBacklink,
  emptyJoin,
  finishJoin,
  formatStranded,
  graceHoursRemaining,
  isExpiredRow,
  joinReleases,
  main,
  parseArgs,
  reportLines,
  rowNamesKey,
  sweep,
} from '../../scripts/find-stranded-payloads.mjs';

/** Base64url of `text`, the encoding the backlink metadata uses. */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** One page holding a released key: its delete marker, current, and the payload behind it. */
const releasedPage = (key) => ({
  Versions: [{ Key: key, VersionId: `${key}-v1`, IsLatest: false, LastModified: '2026-09-19T11:00:00Z' }],
  DeleteMarkers: [
    { Key: key, VersionId: `${key}-mark`, IsLatest: true, LastModified: '2026-09-19T12:00:00Z' },
  ],
});

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

/**
 * A DynamoDB stand-in over plain items keyed by `pk|sk`. A key listed in
 * `refuses` rejects the way DynamoDB rejects one it will not accept.
 */
function fakeDynamo(items = {}, refuses = {}) {
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
      const id = `${command.input.Key.PK.S}|${command.input.Key.SK.S}`;
      if (refuses[id] !== undefined) {
        const error = new Error(refuses[id]);
        error.name = refuses[id];
        return Promise.reject(error);
      }
      const item = items[id];
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
    joinReleases([page]).map((release) => [
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
  assert.equal(joinReleases([page])[0].payloadVersionId, 'd-new');
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
      .flatMap((page) => joinReleases([page]))
      .filter((release) => release.payloadVersionId !== null);
    assert.deepEqual(perPage, [], 'a per-page join pairs no payload with this marker');
    assert.deepEqual(
      joinReleases(pages).map((r) => [r.key, r.markerVersionId, r.payloadVersionId]),
      [['p/e.bin', 'e-mark', 'e-1']],
    );
  }
});

test('the join holds one key at a time and emits a release the moment that key closes', () => {
  /**
   * `ListObjectVersions` answers in ascending key order and resumes at a
   * position in that same order, so a key is complete as soon as a later key
   * appears. The sweep is run after an incident, on a bucket whose marker set
   * has no upper bound without the reclaim rule, so the join must not grow with
   * the listing: it keeps the open key's entries and nothing else.
   */
  const closed = [];
  const join = emptyJoin((release) => closed.push(release.key));

  addVersionsPage(join, releasedPage('p/a.bin'));
  assert.deepEqual(closed, [], 'a key is still open until a later key appears');
  assert.equal(join.open.key, 'p/a.bin');

  addVersionsPage(join, releasedPage('p/b.bin'));
  assert.deepEqual(closed, ['p/a.bin'], 'the earlier key closes as soon as a later one opens');
  assert.equal(join.open.key, 'p/b.bin');
  assert.equal(join.open.versions.length + join.open.markers.length, 2);

  finishJoin(join);
  assert.deepEqual(closed, ['p/a.bin', 'p/b.bin']);
  assert.equal(join.open, null);
  assert.ok(
    !('keys' in join),
    'the join must not retain a per-key map of the whole listing; it holds the open key only',
  );
});

test('a key listed after a later key had closed fails the sweep rather than being trusted', () => {
  /**
   * The ordering the streaming join rests on is checked, not assumed. One
   * retained key and one comparison catch a listing that is not ascending —
   * including a key reappearing after it was closed, which is the shape that
   * would silently split one key's entries into two half-joins.
   */
  const descending = emptyJoin(() => {});
  addVersionsPage(descending, releasedPage('p/b.bin'));
  assert.throws(
    () => addVersionsPage(descending, releasedPage('p/a.bin')),
    /ascending key order/,
    'a key below the last closed one must fail the sweep',
  );

  const reappearing = emptyJoin(() => {});
  addVersionsPage(reappearing, releasedPage('p/b.bin'));
  addVersionsPage(reappearing, releasedPage('p/c.bin'));
  assert.throws(() => addVersionsPage(reappearing, releasedPage('p/b.bin')), /p\/b\.bin/);
});

test('a key whose current version is an object is not a release, however many markers it carries', () => {
  /**
   * A key released and then written again — the same object id re-landing, or
   * a legacy store key that carries no per-write segment and is rewritten in
   * place — keeps its delete marker as a noncurrent entry. Its payload is
   * current and readable, so there is nothing stranded; calling it stranded
   * would offer an operator a `DeleteItem` on a healthy row.
   */
  const page = {
    Versions: [
      { Key: 'p/g.bin', VersionId: 'g-2', IsLatest: true, LastModified: '2026-09-19T14:00:00Z' },
      { Key: 'p/g.bin', VersionId: 'g-1', IsLatest: false, LastModified: '2026-09-19T10:00:00Z' },
    ],
    DeleteMarkers: [
      { Key: 'p/g.bin', VersionId: 'g-mark', IsLatest: false, LastModified: '2026-09-19T12:00:00Z' },
    ],
  };
  assert.deepEqual(joinReleases([page]), []);
});

test('a marker whose last version has already expired joins to no payload', () => {
  const page = {
    DeleteMarkers: [
      { Key: 'p/f.bin', VersionId: 'f-mark', IsLatest: true, LastModified: '2026-09-01T00:00:00Z' },
    ],
  };
  assert.equal(joinReleases([page])[0].payloadVersionId, null);
});

test('graceHoursRemaining counts from the marker, and goes negative once spent', () => {
  const marker = new Date('2026-09-20T00:00:00Z');
  assert.equal(graceHoursRemaining(marker, 1, new Date('2026-09-20T06:00:00Z').getTime()), 18);
  assert.equal(graceHoursRemaining(marker, 1, new Date('2026-09-21T06:00:00Z').getTime()), -6);
});

test('decodeBacklink reads the two base64url metadata fields, astral characters included', () => {
  const pk = 'STORE#\u{1F600}ns';
  const sk = 'k/é中';
  assert.deepEqual(decodeBacklink({ 'dynamodb-pk-b64': b64(pk), 'dynamodb-sk-b64': b64(sk) }), {
    pk,
    sk,
  });
  assert.deepEqual(
    decodeBacklink({ 'DynamoDB-PK-B64': b64('CHKPT#t'), 'DYNAMODB-SK-B64': b64('PAYLOAD##c') }),
    { pk: 'CHKPT#t', sk: 'PAYLOAD##c' },
  );
  assert.equal(decodeBacklink({ 'dynamodb-pk-b64': b64('CHKPT#t') }), null);
  assert.equal(decodeBacklink(undefined), null);
});

test('decodeBacklink refuses a value that is not the base64url of what it decodes to', () => {
  /**
   * Node's base64 decoder drops characters outside the alphabet instead of
   * throwing, so a malformed value decodes to something rather than to an
   * error. Re-encoding is what tells the two apart. An empty part matters most:
   * DynamoDB rejects an empty key attribute outright, so letting one through
   * would end the sweep on a `ValidationException` instead of skipping one
   * unreadable object.
   */
  const good = b64('CHKPT#t');
  for (const bad of ['', '!!!', 'not base64url!', 'a', '====']) {
    assert.equal(
      decodeBacklink({ 'dynamodb-pk-b64': bad, 'dynamodb-sk-b64': good }),
      null,
      `a pk of ${JSON.stringify(bad)} must not decode`,
    );
    assert.equal(decodeBacklink({ 'dynamodb-pk-b64': good, 'dynamodb-sk-b64': bad }), null);
  }
});

test('rowNamesKey walks the whole row, whatever attribute holds the descriptor', () => {
  assert.equal(rowNamesKey({ checkpoint: offloaded('p/x.bin') }, 'p/x.bin'), true);
  assert.equal(rowNamesKey({ value: offloaded('p/y.bin') }, 'p/x.bin'), false);
  assert.equal(rowNamesKey({ metadata: { bytes: 'inline' } }, 'p/x.bin'), false);
  assert.equal(rowNamesKey({ nested: [{ deep: offloaded('p/x.bin') }] }, 'p/x.bin'), true);
});

/**
 * The fixture every sweep test below runs against. It reaches each branch
 * exactly once: one strand, one row that is gone, one superseded row, one key
 * rewritten after its release, three objects unreadable for three different
 * reasons, one marker whose payload has expired, and one key never released.
 */
function sweepFixture() {
  const at = (key, suffix, time) => ({
    Key: key,
    VersionId: `${key}-${suffix}`,
    IsLatest: false,
    LastModified: time,
  });
  const marker = (key, isLatest = true) => ({
    Key: key,
    VersionId: `${key}-mark`,
    IsLatest: isLatest,
    LastModified: '2026-09-20T00:00:00Z',
  });
  const withPayload = ['p/live.bin', 'p/gone.bin', 'p/super.bin', 'p/nometa.bin', 'p/badmeta.bin', 'p/404.bin'];
  /**
   * `p/alive.bin` was never released, so it contributes a version and no
   * marker. It is what makes the two arrays non-parallel, and what turns a
   * join by position into wrong `HeadObject` calls rather than lucky ones.
   * `p/rewritten.bin` carries a marker that is no longer current, so its
   * payload is live and it is not a release at all. `p/expired.bin` carries a
   * marker with nothing left behind it.
   */
  const alive = { ...at('p/alive.bin', 'v1', '2026-09-19T22:00:00Z'), IsLatest: true };
  const rewritten = [
    { ...at('p/rewritten.bin', 'v2', '2026-09-20T02:00:00Z'), IsLatest: true },
    at('p/rewritten.bin', 'v1', '2026-09-19T20:00:00Z'),
  ];
  const pages = [
    {
      Versions: [
        alive,
        ...rewritten,
        ...withPayload.map((key) => at(key, 'v1', '2026-09-19T23:00:00Z')),
      ],
      DeleteMarkers: [
        ...withPayload.map((key) => marker(key)),
        marker('p/expired.bin'),
        marker('p/rewritten.bin', false),
      ],
    },
  ];
  const meta = (pk, sk) => ({ Metadata: { 'dynamodb-pk-b64': b64(pk), 'dynamodb-sk-b64': b64(sk) } });
  const heads = {
    'p/live.bin|p/live.bin-v1': meta('CHKPT#t1', 'PAYLOAD##c1'),
    'p/gone.bin|p/gone.bin-v1': meta('CHKPT#t2', 'PAYLOAD##c2'),
    'p/super.bin|p/super.bin-v1': meta('STORE#ns', 'k3'),
    'p/nometa.bin|p/nometa.bin-v1': { Metadata: {} },
    'p/badmeta.bin|p/badmeta.bin-v1': {
      Metadata: { 'dynamodb-pk-b64': '!!not base64url!!', 'dynamodb-sk-b64': '' },
    },
    /** Mapped so a regression that reports this key shows up as a strand, not as a 404. */
    'p/rewritten.bin|p/rewritten.bin-v1': meta('CHKPT#t4', 'PAYLOAD##c4'),
  };
  const items = {
    'CHKPT#t1|PAYLOAD##c1': { PK: 'CHKPT#t1', SK: 'PAYLOAD##c1', checkpoint: offloaded('p/live.bin') },
    'STORE#ns|k3': { PK: 'STORE#ns', SK: 'k3', value: offloaded('p/newer.bin') },
    'CHKPT#t4|PAYLOAD##c4': {
      PK: 'CHKPT#t4',
      SK: 'PAYLOAD##c4',
      checkpoint: offloaded('p/rewritten.bin'),
    },
  };
  return { pages, heads, items };
}

/** The sweep over {@link sweepFixture}, at a fixed `now` six hours into the grace. */
async function runSweep(refuses = {}) {
  const { pages, heads, items } = sweepFixture();
  const s3 = fakeS3({ pages, heads });
  const ddb = fakeDynamo(items, refuses);
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
  assert.equal(result.markers, 8);
  assert.equal(result.versions, 9);
  assert.equal(result.releases, 7);
  assert.equal(result.checked, 6);
  assert.equal(result.expired, 1);
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
    [
      'p/404.bin-v1',
      'p/badmeta.bin-v1',
      'p/gone.bin-v1',
      'p/live.bin-v1',
      'p/nometa.bin-v1',
      'p/super.bin-v1',
    ],
  );
  assert.ok(ddb.sent.every((entry) => entry.input.ConsistentRead === true));
});

test('a row that is gone, and one that now names another object, are both left out', async () => {
  const { result, ddb } = await runSweep();
  const read = ddb.sent.map((entry) => `${entry.input.Key.PK.S}|${entry.input.Key.SK.S}`);
  assert.ok(read.includes('CHKPT#t2|PAYLOAD##c2'), 'the released row must be looked up');
  assert.ok(read.includes('STORE#ns|k3'), 'the superseded row must be looked up');
  assert.deepEqual(
    result.stranded.map((row) => row.key),
    ['p/live.bin'],
  );
});

test('a key rewritten after its release is never even looked up', async () => {
  const { s3, ddb } = await runSweep();
  const looked = [...s3.sent, ...ddb.sent].map((entry) => JSON.stringify(entry.input));
  assert.ok(
    !looked.some((input) => input.includes('p/rewritten.bin') || input.includes('CHKPT#t4')),
    'a key whose current version is an object is not a release and costs no request',
  );
});

test('an object whose backlink cannot be read is reported and the sweep goes on', async () => {
  const { result, ddb } = await runSweep();
  assert.deepEqual(
    result.unreadable.map((row) => row.key).sort(),
    ['p/404.bin', 'p/badmeta.bin', 'p/nometa.bin'],
  );
  const read = ddb.sent.map((entry) => `${entry.input.Key.PK.S}|${entry.input.Key.SK.S}`);
  assert.ok(
    read.every((id) => !id.startsWith('|') && !id.endsWith('|')),
    'a malformed backlink must never become a GetItem on an empty key attribute',
  );
  assert.equal(result.stranded.length, 1);
});

test('a row DynamoDB refuses is reported rather than ending the sweep', async () => {
  const { result } = await runSweep({ 'CHKPT#t2|PAYLOAD##c2': 'ProvisionedThroughputExceededException' });
  assert.ok(
    result.unreadable.some((row) => row.reason.includes('ProvisionedThroughputExceededException')),
    'the failed row read must be reported',
  );
  assert.deepEqual(
    result.stranded.map((row) => row.key),
    ['p/live.bin'],
    'the keys after it must still be swept',
  );
});

test('nothing is ever repaired: every branch of the sweep sends only reading commands', async () => {
  const { result, s3, ddb } = await runSweep();
  /** Without these the assertions below would only cover the paths this fixture happens to walk. */
  assert.ok(result.stranded.length > 0, 'the fixture must reach the stranded branch');
  assert.ok(result.expired > 0, 'the fixture must reach the no-surviving-version branch');
  assert.equal(result.unreadable.length, 3, 'the fixture must reach all three unreadable branches');
  assert.ok(result.checked < result.releases, 'the fixture must skip at least one release');

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

test('isExpiredRow reads a row past its ttl as gone, as every read of this package does', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const second = Math.floor(now / 1000);
  assert.equal(isExpiredRow({ ttl: second }, now), true);
  assert.equal(isExpiredRow({ ttl: second + 1 }, now), false);
  assert.equal(isExpiredRow({}, now), false);
});

/**
 * A row's own `ttl` is not what every reader tests. `getTuple`/`list` judge a
 * checkpoint by its META row alone and then serve its PAYLOAD row and every
 * pending-WRITE row without checking either row's own `ttl` — so one of those
 * can be past its own `ttl` while its checkpoint is still live and served, and
 * a stranded one of those is a real broken checkpoint, not ordinary expiry.
 * The fixtures below are deliberately minimal, realistic row shapes — the same
 * `PK`/`SK` conventions `src/checkpointer/internal/rows.ts`,
 * `src/store/internal/rows.ts` and `src/history/internal/rows.ts` compose —
 * rather than reusing {@link sweepFixture}, so each test isolates exactly one
 * row kind and one ttl/META combination.
 */
const TTL_NOW = Date.parse('2026-09-27T12:00:00Z');
const TTL_EXPIRED = Math.floor(TTL_NOW / 1000) - 60;
const TTL_LIVE = Math.floor(TTL_NOW / 1000) + 60 * 60 * 24;
const TTL_KEY = 'langgraph-checkpoints/ttl.bin';

/**
 * A sweep over exactly one released key (`TTL_KEY`), whose surviving
 * payload's backlink points at `row`'s own key, with `row` — and, when given,
 * `metaRow` at its own key — served back by a hand-rolled DynamoDB. Every
 * case below needs only this: one release, one backlink, one candidate row,
 * and, for a checkpoint PAYLOAD or WRITE candidate, its checkpoint's META row.
 * `refuses` is passed straight through to `fakeDynamo`, for the one test that
 * needs the META lookup itself to fail.
 */
async function sweepOneRow({ row, metaRow, refuses }) {
  const s3 = fakeS3({
    pages: [releasedPage(TTL_KEY)],
    heads: {
      [`${TTL_KEY}|${TTL_KEY}-v1`]: {
        Metadata: { 'dynamodb-pk-b64': b64(row.PK), 'dynamodb-sk-b64': b64(row.SK) },
      },
    },
  });
  const items = { [`${row.PK}|${row.SK}`]: row };
  if (metaRow !== undefined) items[`${metaRow.PK}|${metaRow.SK}`] = metaRow;
  const ddb = fakeDynamo(items, refuses);
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    graceDays: 1,
    now: TTL_NOW,
  });
  return { result, ddb };
}

test('an expired checkpoint META row is skipped: getTuple already hides it by its own ttl', async () => {
  const row = {
    PK: 'CHKPT#t1',
    SK: 'META#ns#c1',
    threadId: 't1',
    checkpointNs: 'ns',
    checkpointId: 'c1',
    metadata: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({ row });
  assert.deepEqual(result.stranded, []);
  assert.equal(result.expiredRows, 1);
});

test('an expired store item row is skipped: store.get/search already hide it by its own ttl', async () => {
  const row = {
    PK: 'STORE#ns0',
    SK: 'ns1#k1',
    namespace: ['ns0', 'ns1'],
    key: 'k1',
    value: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({ row });
  assert.deepEqual(result.stranded, []);
  assert.equal(result.expiredRows, 1);
});

test('an expired history message row is skipped: getMessages already hides it by its own ttl', async () => {
  const row = {
    PK: 'HIST#s1',
    SK: 'HISTORY#MSG#01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sessionId: 's1',
    message: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({ row });
  assert.deepEqual(result.stranded, []);
  assert.equal(result.expiredRows, 1);
});

/**
 * A pending-WRITE row is never gated by any `ttl` at all, its own checkpoint's
 * META included: `migratePendingSends` lets a pre-v4 checkpoint's *child* read
 * a parent's pending writes through the child's own `getTuple`/`list`,
 * without ever reading the parent's META row, so a live child can still be
 * serving a WRITE row whose own checkpoint's META is expired or absent. No
 * `GetItem` this script could send would rule that out, so it costs none: an
 * expired WRITE row is always reported, whatever its own checkpoint's META
 * row says or whether that row is even read.
 */
test('an expired WRITE row is reported when its checkpoint META row is live, and costs no META GetItem', async () => {
  const row = {
    PK: 'CHKPT#t2',
    SK: 'WRITE#ns#c2#task1#0000000008#chan',
    taskId: 'task1',
    index: 0,
    channel: 'chan',
    writeGroup: 'g1',
    value: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const metaRow = {
    PK: 'CHKPT#t2',
    SK: 'META#ns#c2',
    threadId: 't2',
    checkpointNs: 'ns',
    checkpointId: 'c2',
    metadata: offloaded('langgraph-checkpoints/unrelated.bin'),
    ttl: TTL_LIVE,
  };
  const { result, ddb } = await sweepOneRow({ row, metaRow });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t2', 'WRITE#ns#c2#task1#0000000008#chan']],
  );
  assert.equal(result.expiredRows, 0);
  assert.equal(ddb.sent.length, 1, 'a WRITE row must never trigger the checkpoint META lookup');
});

test('an expired WRITE row is reported even when its checkpoint META row is itself expired', async () => {
  const row = {
    PK: 'CHKPT#t2',
    SK: 'WRITE#ns#c2#task1#0000000008#chan',
    taskId: 'task1',
    index: 0,
    channel: 'chan',
    writeGroup: 'g1',
    value: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const metaRow = {
    PK: 'CHKPT#t2',
    SK: 'META#ns#c2',
    threadId: 't2',
    checkpointNs: 'ns',
    checkpointId: 'c2',
    metadata: offloaded('langgraph-checkpoints/unrelated.bin'),
    ttl: TTL_EXPIRED,
  };
  const { result, ddb } = await sweepOneRow({ row, metaRow });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t2', 'WRITE#ns#c2#task1#0000000008#chan']],
  );
  assert.equal(result.expiredRows, 0);
  assert.equal(ddb.sent.length, 1, 'a WRITE row must never trigger the checkpoint META lookup');
});

test('an expired WRITE row is always reported, whatever its META says, because a pre-v4 child could still be serving it without ever reading that META', async () => {
  const row = {
    PK: 'CHKPT#t2',
    SK: 'WRITE#ns#c2#task1#0000000008#chan',
    taskId: 'task1',
    index: 0,
    channel: 'chan',
    writeGroup: 'g1',
    value: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  // No metaRow at all: the checkpoint's META row is absent. Even so, and even
  // though an absent META would hide a PAYLOAD row, a WRITE row is reported:
  // migratePendingSends (src/checkpointer/internal/read.ts) lets a live pre-v4
  // *child* checkpoint serve this checkpoint's pending writes through the
  // child's own getTuple/list, without ever reading this checkpoint's own META
  // row — so this row's own META being absent proves nothing about whether a
  // child still serves it.
  const { result, ddb } = await sweepOneRow({ row });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t2', 'WRITE#ns#c2#task1#0000000008#chan']],
  );
  assert.equal(result.expiredRows, 0);
  assert.equal(ddb.sent.length, 1, 'a WRITE row must never trigger the checkpoint META lookup');
});

test('a live PAYLOAD row costs no extra GetItem: the META lookup only runs for an expired candidate', async () => {
  const row = {
    PK: 'CHKPT#t6',
    SK: 'PAYLOAD#ns#c6',
    checkpoint: offloaded(TTL_KEY),
  };
  const { result, ddb } = await sweepOneRow({ row });
  assert.deepEqual(result.stranded.map((r) => [r.pk, r.sk]), [['CHKPT#t6', 'PAYLOAD#ns#c6']]);
  assert.equal(ddb.sent.length, 1, 'a live candidate must cost exactly its own GetItem, no META lookup');
});

test('an expired PAYLOAD row is still reported when its checkpoint META row is live', async () => {
  const row = {
    PK: 'CHKPT#t3',
    SK: 'PAYLOAD#ns#c3',
    checkpoint: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const metaRow = {
    PK: 'CHKPT#t3',
    SK: 'META#ns#c3',
    threadId: 't3',
    checkpointNs: 'ns',
    checkpointId: 'c3',
    metadata: offloaded('langgraph-checkpoints/unrelated.bin'),
    ttl: TTL_LIVE,
  };
  const { result } = await sweepOneRow({ row, metaRow });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t3', 'PAYLOAD#ns#c3']],
  );
  assert.equal(result.expiredRows, 0);
});

test('an expired PAYLOAD row is skipped when its checkpoint META row is itself expired', async () => {
  const row = {
    PK: 'CHKPT#t3',
    SK: 'PAYLOAD#ns#c3',
    checkpoint: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const metaRow = {
    PK: 'CHKPT#t3',
    SK: 'META#ns#c3',
    threadId: 't3',
    checkpointNs: 'ns',
    checkpointId: 'c3',
    metadata: offloaded('langgraph-checkpoints/unrelated.bin'),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({ row, metaRow });
  assert.deepEqual(result.stranded, []);
  assert.equal(result.expiredRows, 1);
});

test('an expired PAYLOAD row is skipped when its checkpoint META row is absent', async () => {
  const row = {
    PK: 'CHKPT#t3',
    SK: 'PAYLOAD#ns#c3',
    checkpoint: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({ row });
  assert.deepEqual(result.stranded, []);
  assert.equal(result.expiredRows, 1);
});

test('an unrecognisable row past its ttl is reported rather than skipped', async () => {
  /**
   * This is deliberately the shape an earlier draft of this fix would have
   * skipped outright: a row naming the released key, past its own ttl, whose
   * SK matches none of this script's known row-kind tags. Whether a row this
   * shape is truly hidden depends on a reader this script cannot identify, so
   * reporting it is the safe default, not a false positive.
   */
  const row = { PK: 'CHKPT#t9', SK: 'SK', checkpoint: offloaded(TTL_KEY), ttl: TTL_EXPIRED };
  const { result } = await sweepOneRow({ row });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t9', 'SK']],
  );
  assert.equal(result.expiredRows, 0);
});

test('a checkpoint META read that itself fails leaves the candidate reported, not skipped', async () => {
  // Only a PAYLOAD row ever triggers this lookup: a WRITE row never does (see
  // classifyRow), so this case can only arise for the one row kind that is
  // still meta-gated.
  const row = {
    PK: 'CHKPT#t3',
    SK: 'PAYLOAD#ns#c3',
    checkpoint: offloaded(TTL_KEY),
    ttl: TTL_EXPIRED,
  };
  const { result } = await sweepOneRow({
    row,
    refuses: { 'CHKPT#t3|META#ns#c3': 'ProvisionedThroughputExceededException' },
  });
  assert.deepEqual(
    result.stranded.map((r) => [r.pk, r.sk]),
    [['CHKPT#t3', 'PAYLOAD#ns#c3']],
    'a META lookup this script could not complete must not hide a candidate',
  );
  assert.ok(
    result.unreadable.some((entry) => entry.reason.includes('ProvisionedThroughputExceededException')),
    'the failed META lookup is still recorded, for an operator to see why',
  );
});

/**
 * `main` over stand-in constructors: each records the config it was handed and
 * answers the smallest sweep there is, one empty listing page. Nothing reaches
 * the network, and the report is captured so the run stays readable.
 */
async function runMain(argv = ['--bucket', 'b', '--table', 't']) {
  const s3Configs = [];
  const ddbConfigs = [];
  const recording = (configs, answer) => (config) => {
    configs.push(config);
    return { send: () => Promise.resolve(answer), destroy() {} };
  };
  const logged = [];
  const printed = console.log;
  console.log = (line) => logged.push(line);
  try {
    await main(argv, {
      createS3: recording(s3Configs, { IsTruncated: false }),
      createDynamoDB: recording(ddbConfigs, {}),
    });
  } finally {
    console.log = printed;
  }
  return { s3Configs, ddbConfigs, logged };
}

test('both clients are bounded, so a stalled connection fails the sweep instead of hanging it', async () => {
  const { s3Configs, ddbConfigs } = await runMain();
  assert.equal(s3Configs.length, 1);
  assert.equal(ddbConfigs.length, 1);
  const bound = {
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
    throwOnRequestTimeout: true,
  };
  assert.deepEqual(s3Configs[0].requestHandler, bound, 'the S3 client must carry the bound');
  assert.deepEqual(ddbConfigs[0].requestHandler, bound, 'the DynamoDB client must carry the bound');
});

test('neither client is given maxAttempts, so the SDK retries this script relies on survive', async () => {
  const { s3Configs, ddbConfigs } = await runMain();
  for (const config of [...s3Configs, ...ddbConfigs]) {
    assert.ok(
      !('maxAttempts' in config),
      'this script has no retry layer of its own: the SDK’s retries are the only ones',
    );
  }
});

test('neither client is given a connectionTimeout, which would count the wait for a socket', async () => {
  const { s3Configs, ddbConfigs } = await runMain();
  for (const config of [...s3Configs, ...ddbConfigs]) {
    assert.ok(!('connectionTimeout' in config.requestHandler));
    assert.ok(!('connectionTimeout' in config));
  }
});

test('the bound rides on the region the command line asked for, and adds no flag of its own', async () => {
  const { s3Configs, ddbConfigs } = await runMain([
    '--bucket',
    'b',
    '--table',
    't',
    '--region',
    'eu-west-1',
  ]);
  assert.equal(s3Configs[0].region, 'eu-west-1');
  assert.equal(ddbConfigs[0].region, 'eu-west-1');
  const { s3Configs: defaulted } = await runMain();
  assert.ok(!('region' in defaulted[0]), 'no region still means the one from the environment');
});

test('a caller’s own requestHandler replaces the bound whole rather than merging with it', () => {
  const own = { socketTimeout: 1 };
  assert.deepEqual(boundedClientConfig({ requestHandler: own }).requestHandler, own);
  assert.equal(boundedClientConfig({ region: 'eu-west-1' }).region, 'eu-west-1');
});

test('a request that times out is reported as unreadable, never as a stranded row', async () => {
  const { result } = await runSweep({ 'CHKPT#t1|PAYLOAD##c1': 'TimeoutError' });
  const text = reportLines(result).join('\n');
  assert.match(text, /UNREADABLE objectKey=p\/live\.bin .*TimeoutError/);
  assert.deepEqual(result.stranded, [], 'a request the sweep gave up on is not a finding');
  assert.equal(result.checked, 6, 'and the keys after it are still swept');
});

test('a listing that times out fails the sweep, rather than clearing a bucket it never read', async () => {
  /**
   * The other half of the bound. A `HeadObject` or `GetItem` the sweep gave up
   * on is one unreadable row; a `ListObjectVersions` it gave up on is a bucket
   * it did not see, so it must come back out of `main` — which is what the
   * script turns into a non-zero exit — and it must print no report, because a
   * report saying nothing was found is the one answer an operator must never
   * get from a sweep that never listed anything.
   */
  const stall = () => {
    const error = new Error('request timed out');
    error.name = 'TimeoutError';
    return Promise.reject(error);
  };
  const destroyed = [];
  const stalling = (label) => () => ({ send: stall, destroy: () => destroyed.push(label) });
  const logged = [];
  const printed = console.log;
  console.log = (line) => logged.push(line);
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 't'], {
        createS3: stalling('s3'),
        createDynamoDB: stalling('ddb'),
      }),
      { name: 'TimeoutError' },
      'a listing the sweep could not read must fail it, not end it quietly',
    );
  } finally {
    console.log = printed;
  }
  assert.ok(
    !logged.some((line) => line.includes('stranded row(s)')),
    `a sweep that failed must print no report: ${JSON.stringify(logged)}`,
  );
  assert.deepEqual(destroyed, ['s3', 'ddb'], 'and both clients are still closed on the way out');
});
