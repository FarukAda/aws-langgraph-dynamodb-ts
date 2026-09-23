/**
 * Edge-input fuzz over the whole public surface of dist/. cwd must be the repo root.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

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

/**
 * The same client, answering reads out of `rows` instead of resolving every one
 * of them empty.
 *
 * `docMock` resolves each read with nothing, so every case built on it fuzzes
 * *arguments* and nothing downstream of a read has ever run — which is why the
 * commits that changed what a read does with a stored row could not move this
 * baseline. This serves a crafted row instead, so the classification a read
 * puts on a payload, and the refusal a descriptor earns, are outcomes the
 * corpus records rather than claims a unit test makes alone.
 *
 * A row is selected the way the server selects it, from the request the code
 * actually issued: a `Get` matches on the whole key, and a `Query` or `Scan`
 * on the partition the request names (`:pk` exactly, `:pkp` as a prefix) and
 * the sort-key prefix it asks for. Serving rows the request did not ask for
 * would prove only that this mock and the code disagree.
 */
function rowMock(served) {
  const client = ddb.DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
  const mock = mockClient(client);
  const selected = (input) => {
    const values = input.ExpressionAttributeValues || {};
    return served.filter((row) =>
      (values[':pk'] === undefined || row.PK === values[':pk']) &&
      (values[':pkp'] === undefined || String(row.PK).startsWith(values[':pkp'])) &&
      (values[':skp'] === undefined || String(row.SK).startsWith(values[':skp'])));
  };
  mock.rejects(new Error('unstubbed write'));
  mock.on(GetCommand).callsFake((input) => { const row = served.find((r) => r.PK === input.Key.PK && r.SK === input.Key.SK); return row === undefined ? {} : { Item: row }; });
  mock.on(QueryCommand).callsFake((input) => ({ Items: selected(input) }));
  mock.on(ScanCommand).callsFake((input) => ({ Items: selected(input) }));
  mock.on(BatchGetCommand).resolves({ Responses: {} });
  return client;
}
const rows = [];
function outcome(e) {
  if (e === undefined) return 'RESOLVED';
  const name = e && e.name; const code = e && e.code; const field = e && e.context && e.context.field;
  const branded = e && typeof lib.isDynamoDBLangGraphError === 'function' && e instanceof Object && lib.isDynamoDBLangGraphError(e);
  if (code === 'UNEXPECTED_ERROR' && /unstubbed write/.test(e.message)) return 'REACHED-WRITE (input accepted, write attempted)';
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
  s3: [null, 'x', {}, { bucketName: '' }, { bucketName: 123 }, { bucketName: 'b', keyPrefix: '' }, { bucketName: 'b', keyPrefix: '/' }, { bucketName: 'b', keyPrefix: 'a' }, { bucketName: 'b', keyPrefix: '../' }, { bucketName: 'b', keyPrefix: 'a/../b/' }, { bucketName: 'b', keyPrefix: '/a/' }, { bucketName: 'b', keyPrefix: 'a//b/' }, { bucketName: 'b', thresholdBytes: 0 }, { bucketName: 'b', thresholdBytes: 1e12 }, { bucketName: 'b', thresholdBytes: '1' }, { bucketName: 'b', maxDownloadBytes: 0 }, { bucketName: 'b', foo: 1 }, { bucketName: 'b', clientConfig: 'x' }, { bucketName: 'b', serverSideEncryption: 5 }, { bucketName: 'b', keyPrefix: 123 }, { bucketName: 'b', keyPrefix: null }, { bucketName: 'b', sseKmsKeyId: 123 }],
  logger: [null, 'x', {}, { info() {} }, { info: 1, warn: 1, error: 1, debug: 1 }],
  serde: ['x', {}, null, { dumpsTyped() {} }],
  foo: [1],
};
const PER_ADAPTER = {
  DynamoDBStore: {
    index: [null, 'x', {}, { dims: 0 }, { dims: NaN }, { dims: '3' }, { dims: 3 }, { dims: 3, embed: 'x' }, { dims: 3, embed: {} }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, fields: 'x' }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, fields: [1] }, { dims: 3, embed: { embedQuery() {}, embedDocuments() {} }, foo: 1 }, { dims: 3, embeddings: { embedQuery() {}, embedDocuments() {} }, fields: 'x' }, { dims: 3, embeddings: { embedQuery() {}, embedDocuments() {} }, fields: [1] }, { dims: 3, embeddings: { embedQuery() {}, embedDocuments() {} }, foo: 1 }, { dims: 3, embeddings: { embedQuery() {}, embedDocuments() {} }, fields: ['a'] }],
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
    trySync(cls, 'clientConfig=[]', () => new Ctor({ tableName: 'fuzz-table', clientConfig: [] }));
    trySync(cls, 'clientConfig={region,endpoint,credentials,maxAttempts}', () => { const a = new Ctor({ tableName: 'fuzz-table', clientConfig: { region: 'us-east-1', endpoint: 'http://localhost:8000', credentials: { accessKeyId: 'x', secretAccessKey: 'y' }, maxAttempts: 3 } }); a.destroy(); return a; });
    trySync(cls, 'vectorBackend with a usable index (store only)', () => { const a = new Ctor({ ...base(), index: { dims: 3, embeddings: { embedQuery() {}, embedDocuments() {} } }, vectorBackend: { upsert() {}, query() {}, delete() {}, extra: 1 } }); a.destroy(); return a; });
    trySync(cls, 'vectorBackend without index (store only)', () => new Ctor({ ...base(), vectorBackend: { upsert() {}, query() {}, delete() {} } }));
  }
}

const IDS = [undefined, null, '', 123, 'a#b', 'x'.repeat(2000), 'a\u0000b', 'ab\u009bc', '😀', {}, ['a'], ' ', 'a\ud800b', 'ok-id'];
async function fuzzSaver() {
  const saver = new lib.DynamoDBSaver(base());
  const E = 'DynamoDBSaver';
  for (const cfg of [undefined, null, {}, 'x', { configurable: null }, { configurable: 'x' }, { configurable: {} }, { configurable: { thread_id: 't' }, signal: {} }]) await tryAsync(E + '.getTuple', `config=${describe(cfg)}`, () => saver.getTuple(cfg));
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
  for (const v of [undefined, null, {}, 'x', { configurable: { thread_id: 'a#b' } }, { configurable: 'thread-1' }]) await tryIter(E + '.list', `config=${describe(v)}`, () => saver.list(v));
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
  for (const v of [null, 'x', 1, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: '5' }, { limit: 1.5 }, { limit: 1e12 }, { before: 'x' }, { before: new Date('x') }, { before: 123 }, { before: null }, { before: new Date(-1000) }, { before: new Date(2 ** 50) }, { before: new Date(0) }, { signal: 'x' }, { signal: { aborted: false, addEventListener() {} } }, { foo: 1 }]) await tryAsync(E + '.getMessages', `options=${describe(v)}`, () => history.getMessages('s1', v));
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
  for (const v of [undefined, null, 'x', 1, [], { foo: 1 }, { client: docMock(), clientConfig: { region: 'x' } }, { ttl: { days: 0 } }, { retry: 'x' }, { s3: 'x' }, { logger: 'x' }, { tableName: 't' }, { clientConfig: 'x' }]) trySync(E, `base=${describe(v)}`, () => new lib.DynamoDBFactory(v));
  const f = new lib.DynamoDBFactory({ client: docMock() });
  for (const v of [undefined, null, 'x', 1, [], {}, { foo: {} }, { saver: null }, { saver: 'x' }, { saver: [] }, { saver: {} }, { saver: { tableName: 'fuzz-table', client: {} } }, { saver: { tableName: 'fuzz-table', clientConfig: { region: 'x' } } }, { saver: { tableName: 'fuzz-table' }, store: { tableName: 'bad#' } }, { saver: { tableName: 'fuzz-table', foo: 1 } }]) trySync(E + '.createAll', `options=${describe(v)}`, () => { const r = f.createAll(v); r.destroy(); return r; });
  for (const v of [undefined, null, 'x', {}, { tableName: 'fuzz-table', client: {} }, { tableName: 'fuzz-table', foo: 1 }, { tableName: 'fuzz-table', s3: { bucketName: 'b', keyPrefix: 123 } }, { tableName: 'fuzz-table', s3: { bucketName: 'b', keyPrefix: null } }]) trySync(E + '.createSaver', `options=${describe(v)}`, () => f.createSaver(v));
  trySync(E + '.createStore', 'options={} ', () => f.createStore({}));
  trySync(E + '.createChatMessageHistory', "options='x'", () => f.createChatMessageHistory('x'));
  trySync(E + '.createStore', 'options=null', () => f.createStore(null));
  trySync(E + '.createChatMessageHistory', 'options=null', () => f.createChatMessageHistory(null));
  const s3Null = new lib.DynamoDBFactory({ client: docMock(), s3: null });
  trySync(E + '(base s3=null).createAll', 'saver with tableName only', () => { const r = s3Null.createAll({ saver: { tableName: 'fuzz-table' } }); r.destroy(); return r; });
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

/**
 * The plain-JSON serde, which is a value on the public surface rather than a
 * method of an adapter: a caller passes it as `serde`, and may also call it
 * directly to read bytes it holds. Its two methods take whatever that caller
 * hands them, so they are fuzzed like every other entry point — and the rows
 * also record what it silently substitutes, which is the README's table read
 * back off the code.
 */
async function fuzzSerde() {
  const E = 'JSON_SERDE.dumpsTyped';
  const cyc = { a: 1 }; cyc.self = cyc;
  const shown = (v) => { try { return new TextDecoder().decode(v[1]); } catch { return describe(v); } };
  const dumps = [undefined, null, 1, -0, NaN, Infinity, 'x', [], {}, () => 1, Symbol('s'), 1n, { n: 1n }, cyc, { a: 1, b: undefined }, [1, undefined, 3], new Map([['a', 1]]), new Set([1]), new Date(0), new Uint8Array([1, 2, 3]), { f: () => 1 }, { s: Symbol('s') }, { toJSON() { throw new Error('boom'); } }, { thrown: 'primitive', toJSON() { throw 'boom'; } }];
  for (const v of dumps) await tryAsync(E, `value=${describe(v)}`, async () => shown(await lib.JSON_SERDE.dumpsTyped(v)));
  const E2 = 'JSON_SERDE.loadsTyped';
  const bytes = (s) => new TextEncoder().encode(s);
  for (const v of [undefined, null, 42, [], {}, Symbol('s'), '', 'not json', '{"a":1}', bytes(''), bytes('{oops'), bytes('{"a":1}')]) await tryAsync(E2, `data=${describe(v)}`, () => lib.JSON_SERDE.loadsTyped('json', v));
  for (const v of [undefined, null, 1, 'msgpack']) await tryAsync(E2, `type=${describe(v)}`, () => lib.JSON_SERDE.loadsTyped(v, '1'));
  await tryAsync(E2, 'data=bytes of {"__proto__":{"polluted":1}}', () => lib.JSON_SERDE.loadsTyped('json', bytes('{"__proto__":{"polluted":1}}')));
  rows.push(['prototype-safety', 'Object.prototype.polluted after JSON_SERDE.loadsTyped', String(({}).polluted)]);
  trySync('JSON_SERDE', 'Object.isFrozen(JSON_SERDE)', () => Object.isFrozen(lib.JSON_SERDE));
  /**
   * As with `ErrorCode`: the assignment is the probe. A frozen object refuses
   * it, and in a module that refusal is a throw, so letting it reach
   * `outcome()` would file the guarantee as a bare escape.
   */
  trySync('JSON_SERDE', 'swap dumpsTyped (refused?)', () => { const before = lib.JSON_SERDE.dumpsTyped; let refused = false; try { lib.JSON_SERDE.dumpsTyped = () => 1; } catch { refused = true; } const after = lib.JSON_SERDE.dumpsTyped; if (!refused) lib.JSON_SERDE.dumpsTyped = before; return refused && after === before; });
}

const enc = (text) => new TextEncoder().encode(text);

/** An inline payload descriptor in the shape this package writes one, with `extra` last. */
const inlinePayload = (serdeType, text, extra) => ({ location: 'INLINE', serdeType, compressed: false, bytes: enc(text), ...extra });

/** A descriptor every serializer here reads, so a row carries exactly one fault. */
const healthyPayload = () => inlinePayload('json', '{}');

const checkpointRows = (payload) => [
  { PK: 'CHKPT#t', SK: 'META##cp1', v: 1, threadId: 't', checkpointNs: '', checkpointId: 'cp1', metadata: healthyPayload() },
  { PK: 'CHKPT#t', SK: 'PAYLOAD##cp1', v: 1, threadId: 't', checkpointNs: '', checkpointId: 'cp1', checkpoint: payload },
];
const storeItemRows = (payload) => [
  { PK: 'STORE#ns', SK: 'k', v: 1, namespace: ['ns'], key: 'k', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', value: payload },
];
const messageRows = (payload) => [{ PK: 'HIST#s1', SK: 'HISTORY#MSG#01J0', v: 1, sessionId: 's1', message: payload }];

const CKPT_CONFIG = { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'cp1' } };

/**
 * One read per adapter, each given a row it must decode. The chat-history read
 * appears under both corruption policies because the policy is exactly what
 * decides between the two halves of its contract: `skip` drops a payload no
 * reader could recover and keeps the conversation, while a refusal that is not
 * payload loss — a serde declining to rebuild intact bytes, a descriptor a
 * newer release wrote — is reported whatever the policy says.
 */
const STORED_ROW_READERS = [
  ['DynamoDBSaver.getTuple', '', checkpointRows, (o) => new lib.DynamoDBSaver(o), (a) => a.getTuple(CKPT_CONFIG)],
  ['DynamoDBStore.get', '', storeItemRows, (o) => new lib.DynamoDBStore(o), (a) => a.get(['ns'], 'k')],
  ['DynamoDBChatMessageHistory.getMessages', ", onCorruptMessage='skip'", messageRows, (o) => new lib.DynamoDBChatMessageHistory({ ...o, onCorruptMessage: 'skip' }), (a) => a.getMessages('s1')],
  ['DynamoDBChatMessageHistory.getMessages', ", onCorruptMessage='throw'", messageRows, (o) => new lib.DynamoDBChatMessageHistory({ ...o, onCorruptMessage: 'throw' }), (a) => a.getMessages('s1')],
];

/**
 * What a read does with a stored payload, as a grid over the adapter, the
 * serializer and the fault the row carries.
 *
 * The distinction being pinned is between bytes that no longer parse as the
 * form the row declares — nothing can read those, so they are `PAYLOAD_CORRUPT`
 * — and bytes that are intact while the serializer declines to rebuild the
 * value they name, which says what *this* reader may do and is a
 * `ValidationError` naming `serde`. On a row declaring `json` both land the
 * same way on all three adapters and under either serializer, which is the half
 * only a grid can show: the two defaults behave differently on the read,
 * `JsonPlusSerializer` reviving a stored `lc` constructor record where
 * `JSON_SERDE` parses and reconstructs nothing.
 *
 * A `serdeType` this package has no grammar for is a third column, and it is
 * the column where the two serializers used to part: the classifier takes the
 * type at the row's word and never re-reads such a refusal as corruption, but
 * `JSON_SERDE` looked at no declared type at all and branded its own parse
 * failure `PAYLOAD_CORRUPT` before the classifier was consulted, so the same
 * row was a reported refusal on the checkpointer default and payload loss on
 * the store and chat-history defaults — where `skip` then dropped the message.
 * It now refuses the form itself, with the brand the classifier would have
 * reached, so the column lands alike everywhere.
 *
 * The fourth column is that defect in ordinary clothes, reachable by
 * configuration and by nothing else: `JsonPlusSerializer` stamps `bytes` on a
 * raw `Uint8Array`, and those bytes are `123` — valid JSON. Read through
 * `JSON_SERDE` the row used to decode to the *number* 123 and resolve, handing
 * a caller a value no writer ever stored with nothing raised to say so. Only a
 * serializer that reads the declared form can refuse it.
 *
 * A descriptor carrying a forward `schemaVersion` is the last column: the
 * payload is intact and a newer reader serves it, so it is `FORMAT_UNSUPPORTED`
 * rather than loss, on every adapter and under either corruption policy.
 */
async function fuzzStoredRows() {
  const jsonPlus = new (req('@langchain/langgraph-checkpoint').BaseCheckpointSaver)().serde;
  const CUSTOM_TYPE = 'x-custom';
  /** A caller's own serializer, refusing to rebuild what it wrote under its own type. */
  const customSerde = {
    async dumpsTyped(value) { return [CUSTOM_TYPE, enc(JSON.stringify(value))]; },
    async loadsTyped(type, data) {
      if (type === CUSTOM_TYPE) throw new Error('this serde will not rebuild that value');
      return JSON.parse(new TextDecoder().decode(data));
    },
  };
  /** An `lc` constructor record naming a namespace LangGraph's own serializer refuses. */
  const LC_RECORD = '{"lc":1,"type":"constructor","id":["x","Nope"],"kwargs":{}}';
  const grid = [
    ['json bytes that no longer parse', 'default serde', undefined, () => inlinePayload('json', '{oops')],
    ['json bytes that no longer parse', 'JSON_SERDE', lib.JSON_SERDE, () => inlinePayload('json', '{oops')],
    ['json bytes naming a class the serde will not rebuild', 'JsonPlusSerializer', jsonPlus, () => inlinePayload('json', LC_RECORD)],
    ['x-msgpack bytes, which are not JSON', 'default serde', undefined, () => inlinePayload('x-msgpack', '{oops')],
    ['x-msgpack bytes, which are not JSON', 'JSON_SERDE', lib.JSON_SERDE, () => inlinePayload('x-msgpack', '{oops')],
    ['bytes stamped by the checkpointer default on a Uint8Array, which are also valid JSON', 'JSON_SERDE', lib.JSON_SERDE, () => inlinePayload('bytes', '123')],
    [`${CUSTOM_TYPE} bytes the serde refuses`, 'a custom serde', customSerde, () => inlinePayload(CUSTOM_TYPE, '{"a":1}')],
    ['json descriptor carrying schemaVersion 2', 'default serde', undefined, () => inlinePayload('json', '{}', { schemaVersion: 2 })],
  ];
  for (const [entry, suffix, rowsFor, build, read] of STORED_ROW_READERS) {
    for (const [payloadLabel, serdeLabel, serde, payload] of grid) {
      const options = { tableName: 'fuzz-table', client: rowMock(rowsFor(payload())) };
      if (serde !== undefined) options.serde = serde;
      const adapter = build(options);
      await tryAsync(entry, `served row: ${payloadLabel}, serde=${serdeLabel}${suffix}`, () => read(adapter));
      adapter.destroy();
    }
  }
}

/**
 * Teardown with two live resources, which no other case here has: every
 * adapter the corpus builds either injects its client (so the adapter owns
 * none) or never resolves the S3 one, and a teardown with a single resource
 * cannot show a resource that refuses to close stranding the one behind it.
 *
 * Making the S3 client refuse is the one thing in this tier that is not a
 * caller-supplied input: nothing a caller may pass makes a client's own
 * `destroy` throw, so the SDK's method is replaced for the length of the probe
 * and restored after it. Everything the library does is its own — the real
 * offloader, the real release order, the real `destroy` — and the row records
 * whether the DynamoDB client behind the failing resource was still released.
 * The refusal is caught inside the probe and reported as the answer, because a
 * foreign error the adapter deliberately re-raises would otherwise be filed
 * as a bare escape.
 */
async function fuzzTeardown() {
  const { S3Client } = req('@aws-sdk/client-s3');
  const s3 = mockClient(S3Client);
  s3.resolves({});
  /** Asserted before any S3 client exists: no case in this tier may reach AWS. */
  trySync('transport-safety', 'S3 send is intercepted before an S3 client is built', () => Boolean(S3Client.prototype.send.isSinonProxy));
  const realS3Destroy = S3Client.prototype.destroy;
  const realDdbDestroy = DynamoDBClient.prototype.destroy;
  let released = 0;
  DynamoDBClient.prototype.destroy = function () { released += 1; return realDdbDestroy.call(this); };
  try {
    for (const [label, hostile] of [['closes cleanly', false], ['refuses to close', true]]) {
      S3Client.prototype.destroy = hostile ? function () { throw new Error('sockets gone'); } : realS3Destroy;
      await tryAsync('DynamoDBSaver.destroy', `an offloader whose resolved S3 client ${label}`, async () => {
        released = 0;
        const saver = new lib.DynamoDBSaver({ tableName: 'fuzz-table', clientConfig: { region: 'us-east-1' }, ttl: { days: 30 }, s3: { bucketName: 'b' } });
        await saver.ensureS3LifecycleRule();
        let raised = 'none';
        try { saver.destroy(); } catch (e) { raised = e && e.message; }
        return `raised=${raised} ddbReleased=${released}`;
      });
    }
  } finally {
    S3Client.prototype.destroy = realS3Destroy;
    DynamoDBClient.prototype.destroy = realDdbDestroy;
    s3.restore();
  }
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
  /**
   * The assignment is the probe, not a library call: a frozen enum refuses it,
   * and in a module — which is strict mode — that refusal *is* a throw. Letting
   * it reach `outcome()` would file the fix as a bare escape, so the refusal is
   * caught here and reported as the answer the row exists to give.
   */
  trySync('ErrorCode', 'mutate ErrorCode.VALIDATION = "x" (refused?)', () => { const before = lib.ErrorCode.VALIDATION; let refused = false; try { lib.ErrorCode.VALIDATION = 'x'; } catch { refused = true; } const after = lib.ErrorCode.VALIDATION; if (!refused) lib.ErrorCode.VALIDATION = before; return refused && after === before; });
  trySync('errors', 'ValidationError JSON.stringify exposes?', () => Object.keys(JSON.parse(JSON.stringify(new lib.ValidationError('m', 'f')))).join(','));
  /**
   * Both rows answer yes/no, not "what did it hold": a sync row records its
   * value's constructor, so returning the value itself reported `String` or
   * `Number` whichever way the copy went and the ratchet could not see it.
   */
  trySync('errors', 'error.context copied? (mutate the caller object, then re-read)', () => { const ctx = { field: 'f' }; const e = new lib.DynamoDBLangGraphError('m', 'VALIDATION', ctx); ctx.field = 'changed'; return e.context.field === 'f'; });
  trySync('errors', 'BatchWriteIncompleteError.unprocessed copied?', () => { const arr = [{ a: 1 }]; const e = new lib.BatchWriteIncompleteError(0, arr, 1); arr.push({ b: 2 }); return e.unprocessed.length === 1; });
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
  await fuzzSerde();
  await fuzzStoredRows();
  fuzzErrors();
  /** Last: it replaces two SDK methods for the length of its probes and restores them after. */
  await fuzzTeardown();
  return rows.map((row) => [...row]);
}
