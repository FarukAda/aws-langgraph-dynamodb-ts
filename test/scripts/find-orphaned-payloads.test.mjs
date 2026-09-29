/**
 * Unit tests for the orphaned-payload sweep (`scripts/find-orphaned-payloads.mjs`),
 * run with `node --test` via `npm run test:scripts`. Every client is hand-rolled:
 * an object with a `send` answering on the command's constructor name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marshall } from '@aws-sdk/util-dynamodb';

import {
  boundedClientConfig,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_PREFIX,
  deleteOrphans,
  deletionLines,
  main,
  orphanReason,
  parseArgs,
  reportLines,
  sweep,
} from '../../scripts/find-orphaned-payloads.mjs';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const NOW = Date.parse('2026-09-27T12:00:00Z');
const OLD = '2026-09-20T12:00:00Z';
const YOUNG = '2026-09-27T11:00:00Z';
const descriptor = (key) => ({ location: 'S3', s3Key: key, serdeType: 'json', compressed: false });
const backlink = (pk, sk = 'SK') => ({
  Metadata: { 'dynamodb-pk-b64': b64(pk), 'dynamodb-sk-b64': b64(sk) },
});

function fakeS3({ objects = [], heads = {}, deleteErrors = [] } = {}) {
  const sent = [];
  return {
    sent,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    send(command) {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name === 'ListObjectsV2Command') {
        return Promise.resolve({ Contents: objects, IsTruncated: false });
      }
      if (name === 'HeadObjectCommand') {
        const head = heads[command.input.Key];
        if (head === undefined) {
          return Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
        }
        return Promise.resolve(head);
      }
      if (name === 'DeleteObjectsCommand') return Promise.resolve({ Errors: deleteErrors });
      return Promise.reject(new Error(`unexpected ${name}`));
    },
  };
}

function fakeDynamoDB(rows = {}, failing = new Set()) {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    send(command) {
      const pk = command.input.Key.PK.S;
      if (failing.has(pk)) {
        return Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
      }
      const row = rows[pk];
      return Promise.resolve(row === undefined ? {} : { Item: marshall(row) });
    },
  };
}

/**
 * One bucket walking every branch: young, live, gone, expired-but-not-yet-gone,
 * superseded, unreadable twice. `live=1` throughout, so this fixture never
 * trips the "--delete refused: no checked object had evidence of --table"
 * guard.
 */
function fixture() {
  const past = Math.floor(NOW / 1000) - 60;
  const s3 = fakeS3({
    objects: [
      { Key: 'young.bin', LastModified: YOUNG, Size: 1 },
      { Key: 'live.bin', LastModified: OLD, Size: 2 },
      { Key: 'gone.bin', LastModified: OLD, Size: 3 },
      { Key: 'expired.bin', LastModified: OLD, Size: 4 },
      { Key: 'superseded.bin', LastModified: OLD, Size: 5 },
      { Key: 'foreign.bin', LastModified: OLD, Size: 6 },
      { Key: 'throttled.bin', LastModified: OLD, Size: 7 },
    ],
    heads: {
      'live.bin': backlink('CHKPT#live'),
      'gone.bin': backlink('CHKPT#gone'),
      'expired.bin': backlink('CHKPT#expired'),
      'superseded.bin': backlink('STORE#s'),
      'foreign.bin': { Metadata: {} },
      'throttled.bin': backlink('HIST#x'),
    },
  });
  const ddb = fakeDynamoDB(
    {
      'CHKPT#live': { PK: 'CHKPT#live', SK: 'SK', checkpoint: descriptor('live.bin') },
      'CHKPT#expired': {
        PK: 'CHKPT#expired',
        SK: 'SK',
        checkpoint: descriptor('expired.bin'),
        ttl: past,
      },
      'STORE#s': { PK: 'STORE#s', SK: 'SK', value: descriptor('other.bin') },
    },
    new Set(['HIST#x']),
  );
  return { s3, ddb };
}

test('parseArgs reads the defaults, every flag and --delete', () => {
  assert.deepEqual(parseArgs(['--bucket', 'b', '--table', 't']), {
    bucket: 'b',
    table: 't',
    region: undefined,
    prefix: DEFAULT_PREFIX,
    minAgeHours: DEFAULT_MIN_AGE_HOURS,
    delete: false,
  });
  const parsed = parseArgs(['--bucket=b', '--table=t', '--min-age-hours=2', '--prefix', 'p/', '--delete']);
  assert.equal(parsed.minAgeHours, 2);
  assert.equal(parsed.prefix, 'p/');
  assert.equal(parsed.delete, true);
});

test('parseArgs refuses what it cannot run with', () => {
  assert.throws(() => parseArgs(['--table', 't']), /--bucket is required/);
  assert.throws(() => parseArgs(['--bucket', 'b']), /--table is required/);
  assert.throws(() => parseArgs(['--bucket', 'b', '--table', 't', '--nope', 'x']), /unknown argument/);
  assert.throws(() => parseArgs(['--bucket']), /needs a value/);
  assert.throws(() => parseArgs(['--bucket', 'b', '--table', 't', '--min-age-hours', '-1']), /--min-age-hours/);
  assert.throws(() => parseArgs(['--bucket', 'b', '--table', 't', '--delete=yes']), /takes no value/);
});

test('parseArgs enforces a 1-hour floor on --min-age-hours, keeping the 24 h default', () => {
  assert.equal(DEFAULT_MIN_AGE_HOURS, 24);
  assert.throws(
    () => parseArgs(['--bucket', 'b', '--table', 't', '--min-age-hours', '0']),
    /--min-age-hours/,
  );
  assert.throws(
    () => parseArgs(['--bucket', 'b', '--table', 't', '--min-age-hours', '0.5']),
    /--min-age-hours/,
  );
  assert.equal(
    parseArgs(['--bucket', 'b', '--table', 't', '--min-age-hours', '1']).minAgeHours,
    1,
  );
});

test('parseArgs refuses a --prefix that does not scope the objects it sweeps', () => {
  const base = ['--bucket', 'b', '--table', 't', '--prefix'];
  assert.throws(() => parseArgs([...base, '']), /--prefix/);
  assert.throws(() => parseArgs([...base, '/']), /--prefix/);
  assert.throws(() => parseArgs([...base, 'no-trailing-slash']), /--prefix/);
  assert.throws(() => parseArgs([...base, 'a/../b/']), /--prefix/);
  assert.throws(() => parseArgs([...base, 'a/./b/']), /--prefix/);
  assert.throws(() => parseArgs([...base, 'a//b/']), /--prefix/);
  assert.equal(parseArgs([...base, 'p/']).prefix, 'p/');
});

test('parseArgs requires an explicit --prefix for --delete, even though the default is itself a valid prefix', () => {
  assert.throws(
    () => parseArgs(['--bucket', 'b', '--table', 't', '--delete']),
    /--delete requires an explicit --prefix/,
  );
  // Explicit and equal to the default is accepted: the operator opted in.
  const parsed = parseArgs(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete']);
  assert.equal(parsed.delete, true);
  assert.equal(parsed.prefix, DEFAULT_PREFIX);
  // The inline --prefix=value form counts as explicit too.
  const inline = parseArgs(['--bucket', 'b', '--table', 't', `--prefix=${DEFAULT_PREFIX}`, '--delete']);
  assert.equal(inline.delete, true);
});

test('orphanReason says why a read row does not keep its object', () => {
  assert.equal(orphanReason(null, 'k', NOW), 'row-gone');
  assert.equal(orphanReason({ ttl: Math.floor(NOW / 1000), value: descriptor('k') }, 'k', NOW), 'row-expired');
  assert.equal(orphanReason({ value: descriptor('other') }, 'k', NOW), 'row-names-another-object');
  assert.equal(orphanReason({ value: descriptor('k') }, 'k', NOW), null);
});

test('orphanReason treats a descriptor nested inside an array or object as live', () => {
  const namesIt = { writes: [{ index: 0, taskId: 't', value: descriptor('k') }] };
  assert.equal(orphanReason(namesIt, 'k', NOW), null);
  const namesAnother = { writes: [{ index: 0, taskId: 't', value: descriptor('other') }] };
  assert.equal(orphanReason(namesAnother, 'k', NOW), 'row-names-another-object');
});

test('sweep separates deletable orphans from expired-but-not-yet-gone rows, and never judges an object younger than the minimum age', async () => {
  const { s3, ddb } = fixture();
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    minAgeHours: 24,
    now: NOW,
  });
  assert.equal(result.objects, 7);
  assert.equal(result.tooYoung, 1);
  assert.equal(result.checked, 6);
  assert.equal(result.live, 1);
  assert.deepEqual(
    result.orphans.map((orphan) => [orphan.key, orphan.reason]),
    [
      ['gone.bin', 'row-gone'],
      ['superseded.bin', 'row-names-another-object'],
    ],
  );
  assert.deepEqual(
    result.expired.map((entry) => [entry.key, entry.reason, entry.namesThisObject]),
    [['expired.bin', 'row-expired', true]],
  );
  assert.deepEqual(result.unreadable.map((entry) => entry.key), ['foreign.bin', 'throttled.bin']);
  assert.equal(s3.sent.some((entry) => entry.input.Key === 'young.bin'), false);
});

test('sweep records false for namesThisObject when the expired row at a backlinked key names a different object', async () => {
  // Two objects backlinked to the same row: only the one the row's current
  // descriptor actually names should record namesThisObject: true.
  const past = Math.floor(NOW / 1000) - 60;
  const s3 = fakeS3({
    objects: [
      { Key: 'current.bin', LastModified: OLD, Size: 1 },
      { Key: 'stale.bin', LastModified: OLD, Size: 2 },
    ],
    heads: {
      'current.bin': backlink('CHKPT#x'),
      'stale.bin': backlink('CHKPT#x'),
    },
  });
  const ddb = fakeDynamoDB({
    'CHKPT#x': { PK: 'CHKPT#x', SK: 'SK', checkpoint: descriptor('current.bin'), ttl: past },
  });
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    minAgeHours: 24,
    now: NOW,
  });
  const byKey = Object.fromEntries(result.expired.map((entry) => [entry.key, entry.namesThisObject]));
  assert.equal(byKey['current.bin'], true);
  assert.equal(byKey['stale.bin'], false);
});

test('sweep reports a HeadObject rejection as unreadable', async () => {
  const s3 = fakeS3({ objects: [{ Key: 'missing.bin', LastModified: OLD, Size: 1 }], heads: {} });
  const ddb = fakeDynamoDB({});
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    minAgeHours: 24,
    now: NOW,
  });
  assert.deepEqual(result.unreadable, [{ key: 'missing.bin', reason: 'NotFound' }]);
});

test('sweep treats non-canonical base64 in a backlink as unreadable, not as garbage pk/sk', async () => {
  const s3 = fakeS3({
    objects: [{ Key: 'bad.bin', LastModified: OLD, Size: 1 }],
    heads: {
      'bad.bin': { Metadata: { 'dynamodb-pk-b64': 'abc!def', 'dynamodb-sk-b64': b64('SK') } },
    },
  });
  const ddb = fakeDynamoDB({});
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    minAgeHours: 24,
    now: NOW,
  });
  assert.deepEqual(result.unreadable, [
    { key: 'bad.bin', reason: 'no readable dynamodb-pk-b64 / dynamodb-sk-b64 pair' },
  ]);
});

test('sweep follows pagination across pages, passing the continuation token forward', async () => {
  const tokensSeen = [];
  const s3 = {
    send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        tokensSeen.push(command.input.ContinuationToken);
        if (command.input.ContinuationToken === undefined) {
          return Promise.resolve({
            Contents: [{ Key: 'p1.bin', LastModified: OLD, Size: 1 }],
            IsTruncated: true,
            NextContinuationToken: 'tok-1',
          });
        }
        return Promise.resolve({
          Contents: [{ Key: 'p2.bin', LastModified: OLD, Size: 2 }],
          IsTruncated: false,
        });
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
      }
      return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    },
  };
  const ddb = fakeDynamoDB({});
  const result = await sweep({
    s3,
    ddb,
    bucket: 'b',
    table: 't',
    prefix: DEFAULT_PREFIX,
    minAgeHours: 24,
    now: NOW,
  });
  assert.deepEqual(tokensSeen, [undefined, 'tok-1']);
  assert.equal(result.pages, 2);
  assert.equal(result.objects, 2);
});

test('sweep refuses a page that claims more pages but gives no continuation token, rather than looping forever', async () => {
  // If the IsTruncated-without-token guard ever regressed, a fake that keeps
  // resolving the same page would make this test hang instead of fail: the
  // loop would never yield anything to reject on. Rejecting the second
  // ListObjectsV2 call turns that regression into a fast failure instead.
  let calls = 0;
  const s3 = {
    send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        calls += 1;
        if (calls > 1) {
          return Promise.reject(
            new Error('eachObjectPage looped past the malformed page instead of refusing it'),
          );
        }
        return Promise.resolve({ Contents: [], IsTruncated: true });
      }
      return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    },
  };
  const ddb = fakeDynamoDB({});
  await assert.rejects(
    sweep({ s3, ddb, bucket: 'b', table: 't', prefix: DEFAULT_PREFIX, minAgeHours: 24, now: NOW }),
    /NextContinuationToken/,
  );
});

test('deleteOrphans deletes in batches of 1000 and reports what S3 refused', async () => {
  const s3 = fakeS3({ deleteErrors: [{ Key: 'k0', Code: 'AccessDenied' }] });
  const orphans = Array.from({ length: 1500 }, (_, index) => ({ key: `k${index}` }));
  const failed = await deleteOrphans(s3, 'b', orphans);
  const calls = s3.sent.filter((entry) => entry.name === 'DeleteObjectsCommand');
  assert.deepEqual(calls.map((call) => call.input.Delete.Objects.length), [1000, 500]);
  assert.deepEqual(failed[0], { key: 'k0', reason: 'AccessDenied' });
});

test('deleteOrphans catches a batch whose DeleteObjects call throws, and reports every key in it as failed', async () => {
  const s3 = {
    sent: [],
    send(command) {
      this.sent.push(command);
      return Promise.reject(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
    },
  };
  const failed = await deleteOrphans(s3, 'b', [{ key: 'k0' }, { key: 'k1' }]);
  assert.deepEqual(failed, [
    { key: 'k0', reason: 'ServiceUnavailable' },
    { key: 'k1', reason: 'ServiceUnavailable' },
  ]);
  assert.equal(s3.sent.length, 1);
});

test('reportLines lists EXPIRED separately from ORPHAN and explains why an expired row is not deleted', () => {
  const result = {
    bucket: 'b',
    table: 't',
    prefix: 'p/',
    minAgeHours: 24,
    pages: 1,
    objects: 2,
    tooYoung: 0,
    checked: 2,
    live: 0,
    unreadable: [],
    expired: [
      { key: 'e', reason: 'row-expired', pk: 'P', sk: 'S', lastModified: new Date(OLD), size: 4 },
    ],
    orphans: [
      { key: 'k', reason: 'row-gone', pk: 'P', sk: 'S', lastModified: new Date(OLD), size: 9 },
    ],
  };
  const lines = reportLines(result);
  const expiredIndex = lines.findIndex((line) => line.startsWith('EXPIRED objectKey=e'));
  const orphanIndex = lines.findIndex((line) => line.startsWith('ORPHAN objectKey=k'));
  assert.ok(expiredIndex >= 0);
  assert.ok(orphanIndex >= 0);
  assert.match(lines.at(-2), /1 orphaned object\(s\), 9 byte\(s\)/);
  assert.match(lines.at(-1), /1 object\(s\) past their row's ttl.*never deleted/);
});

test('deletionLines says nothing was deleted unless --delete ran, and reports failures otherwise', () => {
  const result = {
    orphans: [
      { key: 'k', reason: 'row-gone', pk: 'P', sk: 'S', lastModified: new Date(OLD), size: 9 },
    ],
  };
  assert.deepEqual(deletionLines(result, undefined), [
    'Nothing was deleted. Re-run with --delete and an explicit --prefix to delete the orphans above.',
  ]);
  assert.deepEqual(deletionLines({ orphans: [] }, undefined), []);
  assert.match(deletionLines(result, { failed: [] }).at(-1), /deleted 1 object\(s\)/);
  const withFailure = deletionLines(result, { failed: [{ key: 'k', reason: 'AccessDenied' }] });
  assert.match(withFailure[0], /DELETE-FAILED objectKey=k reason=AccessDenied/);
  assert.match(withFailure.at(-1), /deleted 0 object\(s\)/);
});

test('main sweeps with bounded clients, deletes on --delete, and releases both clients', async () => {
  const { s3, ddb } = fixture();
  const configs = {};
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
      createS3: (config) => {
        configs.s3 = config;
        return s3;
      },
      createDynamoDB: (config) => {
        configs.ddb = config;
        return ddb;
      },
      now: NOW,
    });
  } finally {
    console.log = log;
  }
  assert.deepEqual(configs.s3, boundedClientConfig({}));
  assert.ok(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'));
  assert.ok(lines.some((line) => line.startsWith('ORPHAN objectKey=gone.bin')));
  assert.ok(s3.destroyed && ddb.destroyed);
  // expired.bin's object is never handed to DeleteObjects.
  const deleteCall = s3.sent.find((entry) => entry.name === 'DeleteObjectsCommand');
  const deletedKeys = deleteCall.input.Delete.Objects.map((object) => object.Key);
  assert.equal(deletedKeys.includes('expired.bin'), false);
});

test('main without --delete never sends DeleteObjects, and still tells the operator nothing was deleted', async () => {
  const { s3, ddb } = fixture();
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['--bucket', 'b', '--table', 't'], {
      createS3: () => s3,
      createDynamoDB: () => ddb,
      now: NOW,
    });
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
  assert.ok(lines.some((line) => line.startsWith('Nothing was deleted.')));
});

test('main refuses --delete when no checked object had evidence of --table, and explains the remedy for a genuinely correct table', async () => {
  const s3 = fakeS3({
    objects: [
      { Key: 'wrong1.bin', LastModified: OLD, Size: 1 },
      { Key: 'wrong2.bin', LastModified: OLD, Size: 2 },
      { Key: 'noise.bin', LastModified: OLD, Size: 3 },
    ],
    heads: {
      'wrong1.bin': backlink('CHKPT#missing1'),
      'wrong2.bin': backlink('CHKPT#missing2'),
      'noise.bin': { Metadata: {} },
    },
  });
  const ddb = fakeDynamoDB({});
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
        createS3: () => s3,
        createDynamoDB: () => ddb,
        now: NOW,
      }),
      (error) => {
        assert.match(error.message, /refusing --delete/);
        assert.match(error.message, /1 unreadable/);
        assert.match(error.message, /0 expired/);
        assert.match(error.message, /0 live/);
        assert.match(error.message, /0 superseded/);
        assert.match(error.message, /AWS CLI/);
        return true;
      },
    );
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
  // The findings were still printed, so the operator can see why.
  assert.ok(lines.some((line) => line.startsWith('ORPHAN objectKey=wrong1.bin')));
  assert.ok(lines.some((line) => line.startsWith('UNREADABLE objectKey=noise.bin')));
});

test('main does not refuse --delete when an expired finding proves --table is right, even though live is 0', async () => {
  const past = Math.floor(NOW / 1000) - 60;
  const s3 = fakeS3({
    objects: [
      { Key: 'gone.bin', LastModified: OLD, Size: 3 },
      { Key: 'expired.bin', LastModified: OLD, Size: 4 },
    ],
    heads: {
      'gone.bin': backlink('CHKPT#gone'),
      'expired.bin': backlink('CHKPT#expired'),
    },
  });
  const ddb = fakeDynamoDB({
    'CHKPT#expired': { PK: 'CHKPT#expired', SK: 'SK', checkpoint: descriptor('expired.bin'), ttl: past },
  });
  const log = console.log;
  console.log = () => {};
  try {
    await main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
      createS3: () => s3,
      createDynamoDB: () => ddb,
      now: NOW,
    });
  } finally {
    console.log = log;
  }
  const deleteCall = s3.sent.find((entry) => entry.name === 'DeleteObjectsCommand');
  assert.ok(deleteCall, '--delete proceeded rather than being refused');
  assert.deepEqual(
    deleteCall.input.Delete.Objects.map((object) => object.Key),
    ['gone.bin'],
  );
});

/**
 * Collision: a prod bucket with 3 live objects, swept against a staging table
 * whose only row happens to collide (store keys are deterministic, so this is
 * ordinary, not contrived) with one of them at STORE#config/global. No row
 * that does not name the checked object's exact key may count as evidence.
 */
function collisionFixture(stagingRow) {
  const s3 = fakeS3({
    objects: [
      { Key: 'prod1.bin', LastModified: OLD, Size: 1 },
      { Key: 'prod2.bin', LastModified: OLD, Size: 2 },
      { Key: 'prod3.bin', LastModified: OLD, Size: 3 },
    ],
    heads: {
      'prod1.bin': backlink('STORE#config', 'global'),
      'prod2.bin': backlink('STORE#a', 'x'),
      'prod3.bin': backlink('STORE#b', 'y'),
    },
  });
  const ddb = fakeDynamoDB(stagingRow ? { 'STORE#config': stagingRow } : {});
  return { s3, ddb };
}

test('main refuses --delete when a colliding LIVE row in --table names a different object (one of three objects collides)', async () => {
  const { s3, ddb } = collisionFixture({
    PK: 'STORE#config',
    SK: 'global',
    value: descriptor('staging-own.bin'),
  });
  const log = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 'staging-table', '--prefix', DEFAULT_PREFIX, '--delete'], {
        createS3: () => s3,
        createDynamoDB: () => ddb,
        now: NOW,
      }),
      (error) => {
        assert.match(error.message, /refusing --delete/);
        assert.match(error.message, /1 superseded/);
        return true;
      },
    );
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
});

test('main refuses --delete when a colliding LIVE row in --table is inline, not S3 (the same collision, a different reason rowNamesKey is false)', async () => {
  const { s3, ddb } = collisionFixture({
    PK: 'STORE#config',
    SK: 'global',
    value: { location: 'INLINE', bytes: new Uint8Array([1, 2, 3]), serdeType: 'json', compressed: false },
  });
  const log = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 'staging-table', '--prefix', DEFAULT_PREFIX, '--delete'], {
        createS3: () => s3,
        createDynamoDB: () => ddb,
        now: NOW,
      }),
      /refusing --delete/,
    );
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
});

test('main refuses --delete when a colliding EXPIRED row in --table names a different object (the collision is expired rather than live)', async () => {
  const past = Math.floor(NOW / 1000) - 60;
  const { s3, ddb } = collisionFixture({
    PK: 'STORE#config',
    SK: 'global',
    value: descriptor('staging-own.bin'),
    ttl: past,
  });
  const log = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 'staging-table', '--prefix', DEFAULT_PREFIX, '--delete'], {
        createS3: () => s3,
        createDynamoDB: () => ddb,
        now: NOW,
      }),
      /refusing --delete/,
    );
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
});

test('main does not refuse --delete when there is nothing to delete: everything old enough is UNREADABLE (a pre-rc.2 bucket) and nothing young was checked', async () => {
  const s3 = fakeS3({
    objects: [
      { Key: 'young.bin', LastModified: YOUNG, Size: 1 },
      { Key: 'legacy.bin', LastModified: OLD, Size: 2 },
    ],
    heads: {
      'legacy.bin': { Metadata: {} },
    },
  });
  const ddb = fakeDynamoDB({});
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
      createS3: () => s3,
      createDynamoDB: () => ddb,
      now: NOW,
    });
  } finally {
    console.log = log;
  }
  assert.equal(s3.sent.some((entry) => entry.name === 'DeleteObjectsCommand'), false);
  assert.ok(lines.some((line) => line.startsWith('UNREADABLE objectKey=legacy.bin')));
});

test('main does not refuse --delete when nothing was old enough to check', async () => {
  const s3 = fakeS3({ objects: [] });
  const ddb = fakeDynamoDB({});
  const log = console.log;
  console.log = () => {};
  try {
    await main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
      createS3: () => s3,
      createDynamoDB: () => ddb,
      now: NOW,
    });
  } finally {
    console.log = log;
  }
});

test('main prints its findings before attempting to delete, and exits non-zero (rejects) when a delete batch throws', async () => {
  const { s3: baseS3, ddb } = fixture();
  const s3 = {
    destroy: baseS3.destroy.bind(baseS3),
    send(command) {
      if (command.constructor.name === 'DeleteObjectsCommand') {
        return Promise.reject(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
      }
      return baseS3.send(command);
    },
  };
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await assert.rejects(
      main(['--bucket', 'b', '--table', 't', '--prefix', DEFAULT_PREFIX, '--delete'], {
        createS3: () => s3,
        createDynamoDB: () => ddb,
        now: NOW,
      }),
      /failed/,
    );
  } finally {
    console.log = log;
  }
  const orphanIndex = lines.findIndex((line) => line.startsWith('ORPHAN objectKey=gone.bin'));
  const failedIndex = lines.findIndex((line) => line.startsWith('DELETE-FAILED objectKey=gone.bin'));
  assert.ok(orphanIndex >= 0, 'the ORPHAN finding was printed');
  assert.ok(failedIndex >= 0, 'the DELETE-FAILED line was printed');
  assert.ok(orphanIndex < failedIndex, 'findings print before the delete outcome');
});
