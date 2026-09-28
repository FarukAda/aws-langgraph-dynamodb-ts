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

/** One bucket walking every branch: young, live, gone, expired, superseded, unreadable twice. */
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

test('orphanReason says why a read row does not keep its object', () => {
  assert.equal(orphanReason(null, 'k', NOW), 'row-gone');
  assert.equal(orphanReason({ ttl: Math.floor(NOW / 1000), value: descriptor('k') }, 'k', NOW), 'row-expired');
  assert.equal(orphanReason({ value: descriptor('other') }, 'k', NOW), 'row-names-another-object');
  assert.equal(orphanReason({ value: descriptor('k') }, 'k', NOW), null);
});

test('sweep reports orphans and never judges an object younger than the minimum age', async () => {
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
      ['expired.bin', 'row-expired'],
      ['superseded.bin', 'row-names-another-object'],
    ],
  );
  assert.deepEqual(result.unreadable.map((entry) => entry.key), ['foreign.bin', 'throttled.bin']);
  assert.equal(s3.sent.some((entry) => entry.input.Key === 'young.bin'), false);
});

test('deleteOrphans deletes in batches of 1000 and reports what S3 refused', async () => {
  const s3 = fakeS3({ deleteErrors: [{ Key: 'k0', Code: 'AccessDenied' }] });
  const orphans = Array.from({ length: 1500 }, (_, index) => ({ key: `k${index}` }));
  const failed = await deleteOrphans(s3, 'b', orphans);
  const calls = s3.sent.filter((entry) => entry.name === 'DeleteObjectsCommand');
  assert.deepEqual(calls.map((call) => call.input.Delete.Objects.length), [1000, 500]);
  assert.deepEqual(failed[0], { key: 'k0', reason: 'AccessDenied' });
});

test('reportLines says nothing was deleted unless --delete ran', () => {
  const result = {
    bucket: 'b',
    table: 't',
    prefix: 'p/',
    minAgeHours: 24,
    pages: 1,
    objects: 1,
    tooYoung: 0,
    checked: 1,
    live: 0,
    unreadable: [],
    orphans: [
      { key: 'k', reason: 'row-gone', pk: 'P', sk: 'S', lastModified: new Date(OLD), size: 9 },
    ],
  };
  const dry = reportLines(result, undefined);
  assert.match(dry.at(-2), /1 orphaned object\(s\), 9 byte\(s\)/);
  assert.match(dry.at(-1), /Nothing was deleted/);
  assert.match(reportLines(result, { failed: [] }).at(-1), /deleted 1 object\(s\)/);
});

test('main sweeps with bounded clients, deletes on --delete, and releases both clients', async () => {
  const { s3, ddb } = fixture();
  const configs = {};
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['--bucket', 'b', '--table', 't', '--delete'], {
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
});
