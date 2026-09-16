/**
 * Edge-input fuzz over the whole public surface of dist/. cwd must be the repo root.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe } from './describe.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const req = (m) => require(require.resolve(m, { paths: [root] }));
const lib = require(path.join(root, 'dist/index.js'));
const { DynamoDBClient } = req('@aws-sdk/client-dynamodb');
const ddb = req('@aws-sdk/lib-dynamodb');
const { mockClient } = req('aws-sdk-client-mock');
const { GetCommand, QueryCommand, ScanCommand, BatchGetCommand } = ddb;
const { HumanMessage } = req('@langchain/core/messages');

function docMock() {
  const client = ddb.DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
  const mock = mockClient(client);
  mock.rejects(new Error('unstubbed write')); mock.on(GetCommand).resolves({}); mock.on(QueryCommand).resolves({ Items: [] }); mock.on(ScanCommand).resolves({ Items: [] }); mock.on(BatchGetCommand).resolves({ Responses: {} });
  return client;
}
const rows = [];
function outcome(e) {
  if (e === undefined) return 'RESOLVED';
  const name = e && e.name; const code = e && e.code; const field = e && e.context && e.context.field;
  const branded = e && typeof lib.isDynamoDBLangGraphError === 'function' && e instanceof Object && lib.isDynamoDBLangGraphError(e);
  if (name === 'UpstreamError' && /unstubbed write/.test(e.message)) return 'REACHED-WRITE (input accepted, write attempted)';
  if (branded) return `throws ${name}/${code}${field ? ` field=${field}` : ''}`;
  return `BARE ${name}`;
}
async function tryAsync(entry, label, fn) {
  let res;
  try { const r = await fn(); res = 'RESOLVED ' + describe(r).slice(0, 40); } catch (e) { res = outcome(e); }
  rows.push([entry, label, res]);
}
function trySync(entry, label, fn) {
  let res;
  try { const r = fn(); res = 'OK ' + (r && r.constructor ? r.constructor.name : describe(r)); } catch (e) { res = 'sync ' + outcome(e); }
  rows.push([entry, label, res]);
}
async function tryIter(entry, label, fn) {
  let res;
  try { const it = fn(); const first = await it.next(); res = 'RESOLVED first=' + describe(first.value).slice(0, 30) + (first.done ? ' done' : ''); } catch (e) { res = outcome(e); }
  rows.push([entry, label, res]);
}

const base = () => ({ tableName: 'fuzz-table', client: docMock() });
const CTOR_CASES = {
  '(options)': [undefined, null, 'str', [], {}, 42],
  tableName: [undefined, null, NaN, '', 'ab', 'a'.repeat(256), 'tbl#x', 'tábla', 123, {}, 'ok_table.name-1'],
  ttl: [null, 'x', {}, { day: 1 }, { days: 0 }, { days: -1 }, { days: NaN }, { days: 1e12 }, { days: '1' }, { days: 1.5 }, { seconds: 0.5 }, { days: 1, seconds: 1 }, { days: 1, foo: 1 }],
  retry: [null, 'x', { maxAttempts: 0 }, { maxAttempts: NaN }, { maxAttempts: 1e12 }, { maxAttempts: '3' }, { maxAttempt: 3 }, { baseDelayMs: -1 }, { baseDelayMs: 10, maxDelayMs: 1 }, { maxAttempts: 1.5 }],
  indexShards: [0, -1, NaN, 1.5, 1e12, '8', null],
  indexName: ['', null, 123, 'x'.repeat(300), 'idx#1', 'idx name'],
  readConcurrency: [0, -1, NaN, 1.5, '8', 1e12, null],
  compression: [null, 'x', {}, { enabled: 'true' }, { enabled: true, level: 10 }, { enabled: true, level: -1 }, { enabled: true, level: 1.5 }, { enabled: true, minSizeBytes: -1 }, { enabled: true, maxDecompressedBytes: 0 }, { enabled: true, foo: 1 }],
  s3: [null, 'x', {}, { bucketName: '' }, { bucketName: 123 }, { bucketName: 'b', keyPrefix: '' }, { bucketName: 'b', keyPrefix: '/' }, { bucketName: 'b', keyPrefix: 'a' }, { bucketName: 'b', thresholdBytes: 0 }, { bucketName: 'b', thresholdBytes: 1e12 }, { bucketName: 'b', thresholdBytes: '1' }, { bucketName: 'b', maxDownloadBytes: 0 }, { bucketName: 'b', foo: 1 }, { bucketName: 'b', clientConfig: 'x' }, { bucketName: 'b', serverSideEncryption: 5 }],
  logger: [null, 'x', {}, { info() {} }, { info: 1, warn: 1, error: 1, debug: 1 }],
  serde: ['x', {}, null, { dumpsTyped() {} }],
  foo: [1],
};
const PER_ADAPTER = {
  DynamoDBStore: {
    index: [null, 'x', {}, { dims: 0 }, { dims: NaN }, { dims: '3' }, { dims: 3 }, { dims: 3, embed: 'x' }, { dims: 3, embed: {} }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, fields: 'x' }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, fields: [1] }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, foo: 1 }],
    maxSearchCandidates: [0, -1, NaN, 'x', 1.5, 1e12],
    maxScanItems: [0, -1, NaN, 'x', 1.5, Infinity],
    vectorScoreDirection: ['Distance', '', null, 1, 'relevance'],
    vectorBackend: [{}, 'x', null, { upsert() {}, query() {}, delete() {} }],
  },
  DynamoDBChatMessageHistory: { onCorruptMessage: ['Skip', '', null, 1, {}, 'throw'] },
};

function fuzzConstructors() {
  for (const cls of ['DynamoDBSaver', 'DynamoDBStore', 'DynamoDBChatMessageHistory']) {
    const Ctor = lib[cls];
    for (const v of CTOR_CASES['(options)']) trySync(cls, `options=${describe(v)}`, () => new Ctor(v));
    const cases = { ...CTOR_CASES, ...(PER_ADAPTER[cls] || {}) };
    for (const [key, values] of Object.entries(cases)) {
      if (key === '(options)') continue;
      for (const v of values) {
        const opts = { ...base() };
        if (key === 'tableName') opts.tableName = v; else opts[key] = v;
        if (key === 'vectorBackend' && v && typeof v === 'object' && v.upsert) opts.index = { dims: 3, embed: { async embedQuery() { return [0, 0, 0]; }, async embedDocuments(d) { return d.map(() => [0, 0, 0]); } } };
        trySync(cls, `${key}=${describe(v)}`, () => { const a = new Ctor(opts); a.destroy(); return a; });
      }
    }
    trySync(cls, 'client + clientConfig both', () => new Ctor({ ...base(), clientConfig: { region: 'x' } }));
    trySync(cls, 'client={} (not a DocumentClient)', () => new Ctor({ tableName: 'fuzz-table', client: {} }));
    trySync(cls, "client='x'", () => new Ctor({ tableName: 'fuzz-table', client: 'x' }));
    trySync(cls, 'clientConfig=null', () => new Ctor({ tableName: 'fuzz-table', clientConfig: null }));
    trySync(cls, "clientConfig='x'", () => new Ctor({ tableName: 'fuzz-table', clientConfig: 'x' }));
    trySync(cls, 'vectorBackend without index (store only)', () => new Ctor({ ...base(), vectorBackend: { upsert() {}, query() {}, delete() {} } }));
  }
}

const IDS = [undefined, null, '', 123, 'a#b', 'x'.repeat(2000), 'a\u0000b', 'ab\u009bc', '😀', {}, ['a'], ' ', 'a\ud800b', 'ok-id'];
async function fuzzSaver() {
  const saver = new lib.DynamoDBSaver(base());
  const E = 'DynamoDBSaver';
  for (const cfg of [undefined, null, {}, 'x', { configurable: null }, { configurable: 'x' }, { configurable: {} }]) await tryAsync(E + '.getTuple', `config=${describe(cfg)}`, () => saver.getTuple(cfg));
  for (const v of IDS) await tryAsync(E + '.getTuple', `thread_id=${describe(v)}`, () => saver.getTuple({ configurable: { thread_id: v } }));
  for (const v of [null, 123, 'a#b', '', 'ns\u0000', {}]) await tryAsync(E + '.getTuple', `checkpoint_ns=${describe(v)}`, () => saver.getTuple({ configurable: { thread_id: 't', checkpoint_ns: v } }));
  for (const v of [null, 123, 'a#b', '', {}]) await tryAsync(E + '.getTuple', `checkpoint_id=${describe(v)}`, () => saver.getTuple({ configurable: { thread_id: 't', checkpoint_id: v } }));
  await tryAsync(E + '.getTuple', 'thread_ts=123 (legacy alias)', () => saver.getTuple({ configurable: { thread_id: 't', thread_ts: 123 } }));
  await tryAsync(E + '.getTuple', 'extra configurable keys', () => saver.getTuple({ configurable: { thread_id: 't', foo: { bar: 1 } } }));
  const okCfg = { configurable: { thread_id: 't', checkpoint_ns: '' } };
  const okCp = { v: 1, id: 'cp1', ts: '2024-01-01T00:00:00.000Z', channel_values: { a: 1 }, channel_versions: { a: 1 }, versions_seen: {} };
  for (const v of [undefined, null, {}, 'x', 1, [], { id: '' }, { id: 123 }, { id: 'a#b' }, { id: 'c1' }, { ...okCp, channel_values: null }, { ...okCp, id: 'x'.repeat(2000) }]) await tryAsync(E + '.put', `checkpoint=${describe(v)}`, () => saver.put(okCfg, v, {}));
  for (const v of [undefined, null, 'x', [], 1, { source: 'input', step: NaN }]) await tryAsync(E + '.put', `metadata=${describe(v)}`, () => saver.put(okCfg, okCp, v));
  for (const v of [undefined, null, 'x', 1, {}]) await tryAsync(E + '.put', `config=${describe(v)}`, () => saver.put(v, okCp, {}));
  await tryAsync(E + '.put', "newVersions='x'", () => saver.put(okCfg, okCp, {}, 'x'));
  const wcfg = { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'cp1' } };
  for (const v of [undefined, null, 'x', {}, [], [null], [[]], [['ch']], [[123, 1]], [['a#b', 1]], [['ch', undefined]], [[Symbol('s'), 1]], [['', 1]], [['ch', 1, 'extra']]]) await tryAsync(E + '.putWrites', `writes=${describe(v)}`, () => saver.putWrites(wcfg, v, 'task1'));
  for (const v of IDS) await tryAsync(E + '.putWrites', `taskId=${describe(v)}`, () => saver.putWrites(wcfg, [['ch', 1]], v));
  await tryAsync(E + '.putWrites', 'no checkpoint_id', () => saver.putWrites(okCfg, [['ch', 1]], 'task1'));
  await tryAsync(E + '.putWrites', 'writes=[] (empty)', () => saver.putWrites(wcfg, [], 'task1'));
  for (const v of [null, 'x', 1, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: NaN }, { limit: '5' }, { limit: 1e12 }, { limit: Infinity }, { before: 'x' }, { before: {} }, { before: { configurable: { checkpoint_id: 'a#b' } } }, { before: { configurable: { checkpoint_id: 123 } } }, { filter: 'x' }, { filter: null }, { filter: [] }, { filter: { a: { $gt: 1 } } }, { foo: 1 }]) await tryIter(E + '.list', `options=${describe(v)}`, () => saver.list({ configurable: { thread_id: 't' } }, v));
  for (const v of [undefined, null, {}, 'x', { configurable: { thread_id: 'a#b' } }]) await tryIter(E + '.list', `config=${describe(v)}`, () => saver.list(v));
  for (const v of IDS) await tryAsync(E + '.deleteThread', `threadId=${describe(v)}`, () => saver.deleteThread(v));
  for (const v of ['x', { signal: 'x' }, { signal: {} }, { signal: null }, { foo: 1 }, null]) await tryAsync(E + '.deleteThread', `options=${describe(v)}`, () => saver.deleteThread('t', v));
  for (const v of [undefined, null, {}, { config: null }, { config: okCfg }, { config: okCfg, channels: 'x' }, { config: okCfg, channels: [] }, { config: okCfg, channels: [1] }, { config: { configurable: { thread_id: 'a#b' } }, channels: ['c'] }]) await tryAsync(E + '.getDeltaChannelHistory', `options=${describe(v)}`, () => saver.getDeltaChannelHistory(v));
  await tryAsync(E + '.ensureS3LifecycleRule', 'no s3/ttl configured', () => saver.ensureS3LifecycleRule());
  saver.destroy();
}

async function fuzzStore() {
  const store = new lib.DynamoDBStore(base());
  const E = 'DynamoDBStore';
  for (const v of [undefined, null, 'x', [], [''], [123], ['a#b'], ['a', 'b'.repeat(2000)], [null], ['ok'], [[]], ['a\u0000'], Array(200).fill('n')]) await tryAsync(E + '.get', `namespace=${describe(v)}`, () => store.get(v, 'k'));
  for (const v of [undefined, '', null, 123, 'a#b', 'x'.repeat(3000), {}, 'ok', 'k\u0000']) await tryAsync(E + '.get', `key=${describe(v)}`, () => store.get(['ns'], v));
  for (const v of [undefined, null, 'x', 1, [], {}, { a: 1 }, () => 1, Symbol('s'), 10n, { a: 10n }, { a: undefined }, { a: () => 1 }, (() => { const c = {}; c.self = c; return c; })()]) await tryAsync(E + '.put', `value=${describe(v)}`, () => store.put(['ns'], 'k', v));
  for (const v of ['x', ['nonexistent'], [123], null, 1, {}]) await tryAsync(E + '.put', `index=${describe(v)}`, () => store.put(['ns'], 'k', { a: 1 }, v));
  await tryAsync(E + '.delete', 'namespace/key bad', () => store.delete(['a#b'], 'k'));
  for (const v of [undefined, null, 'x', [null], [123], ['a#b']]) await tryAsync(E + '.search', `namespacePrefix=${describe(v)}`, () => store.search(v));
  for (const v of [null, 'x', 1, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: '5' }, { limit: 1.5 }, { limit: 1e12 }, { offset: -1 }, { offset: NaN }, { offset: 1.5 }, { offset: '0' }, { filter: 'x' }, { filter: null }, { filter: [] }, { filter: { a: { $foo: 1 } } }, { filter: { 'a#b': 1 } }, { query: 123 }, { query: '' }, { query: null }, { query: ['x'] }, { query: 'text (no index)' }, { signal: 'x' }, { foo: 1 }]) await tryAsync(E + '.search', `options=${describe(v)}`, () => store.search(['ns'], v));
  for (const v of [null, 'x', { maxDepth: 0 }, { maxDepth: -1 }, { maxDepth: NaN }, { maxDepth: '1' }, { limit: 0 }, { limit: -1 }, { offset: -1 }, { prefix: 'x' }, { prefix: [123] }, { suffix: 'x' }, { prefix: ['a#b'] }, { foo: 1 }, { prefix: ['a'], suffix: ['b'] }]) await tryAsync(E + '.listNamespaces', `options=${describe(v)}`, () => store.listNamespaces(v));
  for (const v of [[], 'x', null, undefined, ['a#b'], [1]]) await tryAsync(E + '.reconcileVectorIndex', `prefix=${describe(v)} (no index)`, () => store.reconcileVectorIndex(v));
  for (const v of [undefined, null, 'x', {}, [null], ['x'], [{}], [{ namespace: 'x', key: 'k' }], [{ namespace: ['a#b'], key: 'k' }], [{ namespace: ['a'], key: 'k', value: 1 }], [{ namespacePrefix: 'x' }], [{ matchConditions: 'x' }]]) await tryAsync(E + '.batch', `operations=${describe(v)}`, () => store.batch(v));
  await tryAsync(E + '.ensureS3LifecycleRule', 'no s3/ttl configured', () => store.ensureS3LifecycleRule());
  store.destroy();
}

async function fuzzHistory() {
  const history = new lib.DynamoDBChatMessageHistory(base());
  const E = 'DynamoDBChatMessageHistory';
  for (const v of IDS) await tryAsync(E + '.getMessages', `sessionId=${describe(v)}`, () => history.getMessages(v));
  for (const v of [null, 'x', 1, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: '5' }, { limit: 1.5 }, { limit: 1e12 }, { before: 'x' }, { before: new Date('x') }, { before: 123 }, { before: null }, { before: new Date(-1000) }, { before: new Date(2 ** 50) }, { before: new Date(0) }, { signal: 'x' }, { foo: 1 }]) await tryAsync(E + '.getMessages', `options=${describe(v)}`, () => history.getMessages('s1', v));
  for (const v of [undefined, null, 'x', {}, [null], ['x'], [{ type: 'human', content: 'x' }], [{}], [new HumanMessage('hi'), 5], [new HumanMessage('hi'), null], [1]]) await tryAsync(E + '.addMessages', `messages=${describe(v)}`, () => history.addMessages('s1', v));
  await tryAsync(E + '.addMessages', 'messages=[] (empty)', () => history.addMessages('s1', []));
  for (const v of [null, 'x', {}, 5]) await tryAsync(E + '.addMessage', `message=${describe(v)}`, () => history.addMessage('s1', v));
  for (const v of IDS) await tryAsync(E + '.addMessages', `sessionId=${describe(v)}`, () => history.addMessages(v, [new HumanMessage('hi')]));
  for (const v of IDS) await tryAsync(E + '.clear', `sessionId=${describe(v)}`, () => history.clear(v));
  for (const v of [null, 'x', 1, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: '5' }, { limit: 1.5 }, { limit: 1e12 }, { cursor: 'x' }, { cursor: 123 }, { cursor: '' }, { maxItems: 0 }, { maxItems: -1 }, { maxItems: 'x' }, { maxItems: Infinity }, { maxIterations: 0 }, { maxIterations: 1.5 }, { signal: 'x' }, { foo: 1 }]) await tryAsync(E + '.listSessions', `options=${describe(v)} (no indexName)`, () => history.listSessions(v));
  const indexed = new lib.DynamoDBChatMessageHistory({ ...base(), indexName: 'gsi1' });
  const b64 = (s) => Buffer.from(s).toString('base64url');
  for (const v of [{ cursor: 'not base64!' }, { cursor: b64('nohash') }, { cursor: b64('a#b') }, { cursor: b64('') }, { cursor: b64('#') }, { cursor: 123 }, { limit: 0 }]) await tryAsync(E + '.listSessions', `options=${describe(v)} (indexName set)`, () => indexed.listSessions(v));
  indexed.destroy();
  for (const v of IDS) await tryAsync(E + '.reconcileMessageCount', `sessionId=${describe(v)}`, () => history.reconcileMessageCount(v));
  for (const v of IDS) trySync(E + '.forSession', `sessionId=${describe(v)}`, () => history.forSession(v));
  for (const v of [{ limit: 0 }, { limit: -1 }, { limit: '5' }, { limit: NaN }, 'x', { foo: 1 }, null]) trySync(E + '.forSession', `window=${describe(v)}`, () => history.forSession('s1', v));
  for (const v of [{ limit: 0 }, { limit: '5' }, { foo: 1 }]) await tryAsync(E + '.forSession(...).getMessages', `window=${describe(v)}`, () => history.forSession('s1', v).getMessages());
  await tryAsync(E + '.forSession(bad).getMessages', "sessionId='a#b'", () => history.forSession('a#b').getMessages());
  trySync('DynamoDBSessionChatMessageHistory', 'new (backend=null, sessionId=1)', () => new lib.DynamoDBSessionChatMessageHistory(null, 1));
  await tryAsync('DynamoDBSessionChatMessageHistory.getMessages', 'backend=null', () => new lib.DynamoDBSessionChatMessageHistory(null, 's').getMessages());
  await tryAsync('DynamoDBSessionChatMessageHistory.addMessages', 'backend={} (no methods)', () => new lib.DynamoDBSessionChatMessageHistory({}, 's').addMessages([]));
  await tryAsync(E + '.ensureS3LifecycleRule', 'no s3/ttl configured', () => history.ensureS3LifecycleRule());
  history.destroy();
}

function fuzzFactory() {
  const E = 'DynamoDBFactory';
  for (const v of [undefined, null, 'x', 1, [], { foo: 1 }, { client: docMock(), clientConfig: { region: 'x' } }, { ttl: { days: 0 } }, { retry: 'x' }, { s3: 'x' }, { logger: 'x' }, { tableName: 't' }]) trySync(E, `base=${describe(v)}`, () => new lib.DynamoDBFactory(v));
  const f = new lib.DynamoDBFactory({ client: docMock() });
  for (const v of [undefined, null, 'x', 1, [], {}, { foo: {} }, { saver: null }, { saver: 'x' }, { saver: {} }, { saver: { tableName: 'fuzz-table', client: {} } }, { saver: { tableName: 'fuzz-table', clientConfig: { region: 'x' } } }, { saver: { tableName: 'fuzz-table' }, store: { tableName: 'bad#' } }, { saver: { tableName: 'fuzz-table', foo: 1 } }]) trySync(E + '.createAll', `options=${describe(v)}`, () => { const r = f.createAll(v); r.destroy(); return r; });
  for (const v of [undefined, null, 'x', {}, { tableName: 'fuzz-table', client: {} }, { tableName: 'fuzz-table', foo: 1 }]) trySync(E + '.createSaver', `options=${describe(v)}`, () => f.createSaver(v));
  trySync(E + '.createStore', 'options={} ', () => f.createStore({}));
  trySync(E + '.createChatMessageHistory', "options='x'", () => f.createChatMessageHistory('x'));
  const nb = new lib.DynamoDBFactory();
  trySync(E + '(no base).createAll', 'saver with tableName only (builds a real client from env)', () => { const r = nb.createAll({ saver: { tableName: 'fuzz-table' } }); r.destroy(); return r; });
}

async function fuzzBackfill() {
  const E = 'backfillRecencyIndex';
  const client = docMock();
  for (const v of [undefined, null, 'x', {}, { client: {}, tableName: 't' }, { client, tableName: '' }, { client, tableName: 123 }, { client, tableName: 'bad#' }, { client: null, tableName: 'fuzz-table' }]) await tryAsync(E, `options=${describe(v)}`, () => lib.backfillRecencyIndex(v));
  const ok = { client, tableName: 'fuzz-table' };
  for (const v of [0, -1, NaN, '10', 1.5, 1e12, null]) await tryAsync(E, `pageSize=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, pageSize: v }));
  for (const v of [0, -1, NaN, '1', 1.5, null]) await tryAsync(E, `maxPages=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, maxPages: v }));
  for (const v of [0, -1, NaN, '8', 1.5, null]) await tryAsync(E, `indexShards=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, indexShards: v }));
  const b64 = (s) => Buffer.from(s).toString('base64url');
  for (const v of ['', 'x', 123, b64('{}'), b64('[]'), b64('null'), b64('{"PK":1}'), b64('{"PK":"a","SK":"b"}'), b64('{"__proto__":{"x":1}}'), null]) await tryAsync(E, `cursor=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, cursor: v }));
  for (const v of ['false', 1, null]) await tryAsync(E, `dryRun=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, dryRun: v }));
  for (const v of ['x', { maxAttempts: 0 }, { maxAttempts: 'x' }, null]) await tryAsync(E, `retry=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, retry: v }));
  for (const v of ['x', {}, null]) await tryAsync(E, `signal=${describe(v)}`, () => lib.backfillRecencyIndex({ ...ok, signal: v }));
  await tryAsync(E, 'extra key foo=1', () => lib.backfillRecencyIndex({ ...ok, foo: 1 }));
  rows.push(['prototype-safety', 'Object.prototype.x after backfillRecencyIndex cursor', String(({}).x)]);
}

function fuzzRedaction() {
  const E = 'redactSecrets';
  const cyc = {}; cyc.self = cyc;
  class Custom { constructor() { this.password = 'p'; this.keep = 1; } }
  const deep = {}; let cur = deep; for (let i = 0; i < 20000; i++) { cur.n = {}; cur = cur.n; }
  const cases = [undefined, null, 1, NaN, true, 'AKIAIOSFODNN7EXAMPLE', 'Bearer abc.def.ghi', () => 1, Symbol('s'), 10n, [], ['AKIAIOSFODNN7EXAMPLE'], new Map([['token', 'x']]), new Set(['secret']), new Custom(), cyc, JSON.parse('{"__proto__":{"polluted":1}}'), { constructor: { prototype: { polluted: 1 } } }, new Date(0), /re/g, new Uint8Array(3), Object.create(null), { get boom() { throw new Error('getter'); } }, new Error('Credential=AKIAIOSFODNN7EXAMPLE'), deep];
  for (const v of cases) trySync(E, `value=${describe(v)}`, () => { const r = lib.redactSecrets(v); return r; });
  for (const v of ['x', null, [1], [/x/]]) trySync(E, `patterns=${describe(v)}`, () => lib.redactSecrets({ a: 1 }, v));
  for (const v of ['x', null, ['x'], [1]]) trySync(E, `valuePatterns=${describe(v)}`, () => lib.redactSecrets({ a: 'b' }, undefined, v));
  const E2 = 'redactLogger';
  for (const v of [undefined, null, {}, 'x', { info() {} }]) trySync(E2, `inner=${describe(v)}`, () => lib.redactLogger(v));
  const inner = { info() {}, warn() {}, error() {}, debug() {} };
  for (const v of [null, 'x', 1, { extraKeys: 'x' }, { extraKeys: [1] }, { extraKeys: null }, { extraValuePatterns: ['x'] }, { extraValuePatterns: 'x' }, { extraValuePatterns: [/x/] }, { foo: 1 }]) trySync(E2, `options=${describe(v)}`, () => lib.redactLogger(inner, v));
  trySync(E2 + '(...).info', 'inner.info throws', () => lib.redactLogger({ info() { throw new Error('inner'); }, warn() {}, error() {}, debug() {} }).info('m', { a: 1 }));
  trySync(E2 + '(...).info', 'inner={} (missing methods) then .info', () => lib.redactLogger({}).info('m'));
  rows.push(['prototype-safety', 'Object.prototype.polluted after redactSecrets', String(({}).polluted)]);
}

function fuzzErrors() {
  const E = 'errors';
  trySync(E, 'new ValidationError()', () => new lib.ValidationError());
  trySync(E, 'new ValidationError(1, 2, 3)', () => { const e = new lib.ValidationError(1, 2, 3); return e.message + '|' + JSON.stringify(e.context) + '|cause=' + describe(e.cause); });
  trySync(E, 'new UpstreamError(null, "op")', () => new lib.UpstreamError(null, 'op'));
  trySync(E, 'new UpstreamError("str", "op")', () => new lib.UpstreamError('str', 'op'));
  trySync(E, 'new UpstreamError({}, "op")', () => { const e = new lib.UpstreamError({}, 'op'); return e.message; });
  trySync(E, 'new UpstreamError(err) (no operation)', () => { const e = new lib.UpstreamError(new Error('x')); return e.message; });
  trySync(E, 'new RetryExhaustedError("m", "x")', () => { const e = new lib.RetryExhaustedError('m', 'x'); return JSON.stringify(e.context); });
  trySync(E, 'new BatchWriteIncompleteError("a","b","c")', () => { const e = new lib.BatchWriteIncompleteError('a', 'b', 'c'); return e.message; });
  trySync(E, 'new BatchWriteAllIncompleteError()', () => { const e = new lib.BatchWriteAllIncompleteError(); return e.message; });
  trySync(E, 'new CompensationFailedError(null, null)', () => new lib.CompensationFailedError(null, null));
  trySync(E, 'new CompensationFailedError("s", "t")', () => new lib.CompensationFailedError('s', 't'));
  trySync(E, 'new ResultTruncatedError()', () => { const e = new lib.ResultTruncatedError(); return e.message + '|' + JSON.stringify(e.context); });
  trySync(E, 'new AbortError(123)', () => { const e = new lib.AbortError(123); return typeof e.message + ':' + e.message; });
  trySync(E, 'new ConflictError()', () => new lib.ConflictError());
  trySync(E, 'new DynamoDBLangGraphError("m", "NOT_A_CODE", null)', () => { const e = new lib.DynamoDBLangGraphError('m', 'NOT_A_CODE', null); return e.code + '|' + describe(e.context); });
  trySync(E, 'new DynamoDBLangGraphError("m", code, {}, "notAnError")', () => { const e = new lib.DynamoDBLangGraphError('m', 'VALIDATION', {}, 'notAnError'); return describe(e.cause); });
  for (const v of [null, undefined, 'x', {}, 1, new Error('e'), new lib.ValidationError('v')]) trySync('isDynamoDBLangGraphError', `value=${describe(v)}`, () => lib.isDynamoDBLangGraphError(v));
  trySync('isDynamoDBLangGraphError', 'foreign object carrying the brand symbol', () => lib.isDynamoDBLangGraphError({ [Symbol.for('@farukada/aws-langgraph-dynamodb-ts/error')]: true }));
  trySync('ErrorCode', 'Object.isFrozen(ErrorCode)', () => Object.isFrozen(lib.ErrorCode));
  trySync('ErrorCode', 'mutate ErrorCode.VALIDATION = "x"', () => { const before = lib.ErrorCode.VALIDATION; lib.ErrorCode.VALIDATION = 'x'; const after = lib.ErrorCode.VALIDATION; lib.ErrorCode.VALIDATION = before; return `${before}->${after}`; });
  trySync('errors', 'ValidationError JSON.stringify exposes?', () => Object.keys(JSON.parse(JSON.stringify(new lib.ValidationError('m', 'f')))).join(','));
  trySync('errors', 'error.context returned by reference? (mutate then re-read)', () => { const ctx = { field: 'f' }; const e = new lib.DynamoDBLangGraphError('m', 'VALIDATION', ctx); ctx.field = 'changed'; return e.context.field; });
  trySync('errors', 'BatchWriteIncompleteError.unprocessed by reference?', () => { const arr = [{ a: 1 }]; const e = new lib.BatchWriteIncompleteError(0, arr, 1); arr.push({ b: 2 }); return e.unprocessed.length; });
}

/**
 * Run every case and return the rows. Formatting belongs to the normaliser:
 * a collector that also printed could not be diffed without re-parsing text.
 */
export async function collectRows() {
  rows.length = 0;
  fuzzConstructors();
  await fuzzSaver();
  await fuzzStore();
  await fuzzHistory();
  fuzzFactory();
  await fuzzBackfill();
  fuzzRedaction();
  fuzzErrors();
  return rows.map((row) => [...row]);
}
