import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  KEY_SCHEMA_OWNERS,
  keySchemaWrites,
  MESSAGE_COUNT_OWNER,
  messageCountUses,
  VECTOR_COPY_OWNER,
  vectorBackendCalls,
} from './guards/owners';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('keySchemaWrites', () => {
  it('finds a key attribute written as a string, inside an expression, or as a property', () => {
    expect(keySchemaWrites("const names = { '#pk': 'PK' };")).toEqual([1]);
    expect(keySchemaWrites("const c = 'attribute_exists(PK) AND #a = :a';")).toEqual([1]);
    expect(keySchemaWrites('const key = {\n  PK: p,\n  SK: s,\n};')).toEqual([2, 3]);
  });

  it('leaves reading a key, declaring one, a placeholder and a longer word alone', () => {
    expect(keySchemaWrites('const p = row.PK;')).toEqual([]);
    expect(keySchemaWrites('interface K {\n  PK: string;\n}')).toEqual([]);
    expect(keySchemaWrites("const n = { '#pk': PARTITION_KEY_ATTRIBUTE };")).toEqual([]);
    expect(keySchemaWrites("const t = 'TASKS';")).toEqual([]);
  });
});

describe('messageCountUses', () => {
  it('finds the attribute named as a string, read off a value, or written into an object', () => {
    expect(messageCountUses("const n = { '#count': 'messageCount' };")).toEqual([1]);
    expect(messageCountUses('const c = row.messageCount;')).toEqual([1]);
    expect(messageCountUses('const s = { messageCount: 1 };')).toEqual([1]);
  });

  it('leaves a sentence that mentions it, and a declaration, alone', () => {
    expect(messageCountUses("log('messageCount may have drifted');")).toEqual([]);
    expect(messageCountUses('interface S {\n  messageCount: number;\n}')).toEqual([]);
  });
});

describe('vectorBackendCalls', () => {
  it('finds a call only a vector backend answers, and a shared name called on a backend', () => {
    expect(vectorBackendCalls('await backend.upsert(ns, key, v);')).toEqual([1]);
    expect(vectorBackendCalls('await context.vectorBackend.delete(ns, key);')).toEqual([1]);
    expect(vectorBackendCalls('await b.listKeys(prefix);')).toEqual([1]);
  });

  it("leaves a DynamoDB client's query and delete alone", () => {
    expect(vectorBackendCalls('await context.client.query(input);')).toEqual([]);
    expect(vectorBackendCalls('await deps.client.delete(input, request);')).toEqual([]);
  });
});

describe('the source tree', () => {
  const files = listSourceFiles().map((path) => ({
    path: relative(SRC_ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));
  const outside = (owners: readonly string[], find: (text: string) => number[]): string[] =>
    files
      .filter(({ path }) => !owners.includes(path))
      .flatMap(({ path, text }) => find(text).map((line) => `${path}:${line}`));
  const hits = (path: string, find: (text: string) => number[]): number =>
    find(readFileSync(resolve(SRC_ROOT, path), 'utf8')).length;

  it('composes a key, or names a key attribute, only in the row-schema owners', () => {
    expect(outside(KEY_SCHEMA_OWNERS, keySchemaWrites)).toEqual([]);
  });

  it("reads and writes messageCount only in the SESSION row's owner", () => {
    expect(outside([MESSAGE_COUNT_OWNER], messageCountUses)).toEqual([]);
  });

  it("calls the vector backend only from the vector copy's owner", () => {
    expect(outside([VECTOR_COPY_OWNER], vectorBackendCalls)).toEqual([]);
  });

  it('names owners that exist and own what they are named for', () => {
    for (const owner of [...KEY_SCHEMA_OWNERS, MESSAGE_COUNT_OWNER, VECTOR_COPY_OWNER]) {
      expect(existsSync(resolve(SRC_ROOT, owner))).toBe(true);
    }
    for (const owner of KEY_SCHEMA_OWNERS) expect(hits(owner, keySchemaWrites)).toBeGreaterThan(0);
    expect(hits(MESSAGE_COUNT_OWNER, messageCountUses)).toBeGreaterThan(0);
    expect(hits(VECTOR_COPY_OWNER, vectorBackendCalls)).toBeGreaterThan(0);
  });
});
