import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import {
  identityOf,
  offloadedKey,
  readRow,
  type RowProbe,
  verdictFor,
  verifyRow,
} from '../../../../src/shared/dynamodb/write-verify';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const KEY = { PK: 'p', SK: 's' };

function attributeProbe(expected: string | undefined): RowProbe {
  return { key: KEY, kind: 'attribute', attribute: 'rev', expected };
}

function descriptorProbe(expected: string | undefined): RowProbe {
  return { key: KEY, kind: 'descriptor', attribute: 'value', expected };
}

const offloaded = (s3Key: string) => ({
  location: PayloadLocation.S3,
  serdeType: 'json',
  compressed: false,
  s3Key,
});
const inline = { location: PayloadLocation.INLINE, serdeType: 'json', compressed: false };

describe('offloadedKey', () => {
  it('names the key of an offloaded descriptor and nothing else', () => {
    expect(offloadedKey(offloaded('k') as never)).toBe('k');
    expect(offloadedKey(inline as never)).toBeUndefined();
    expect(offloadedKey(undefined)).toBeUndefined();
  });
});

describe('identityOf', () => {
  it('reads a plain attribute straight off the row', () => {
    expect(identityOf(attributeProbe('r1'), { rev: 'r1' })).toBe('r1');
    expect(identityOf(attributeProbe('r1'), {})).toBeUndefined();
    expect(identityOf(attributeProbe('r1'), undefined)).toBeUndefined();
  });

  it('reads the S3 key out of a descriptor attribute', () => {
    expect(identityOf(descriptorProbe('k'), { value: offloaded('k') })).toBe('k');
    expect(identityOf(descriptorProbe('k'), { value: inline })).toBeUndefined();
  });
});

/**
 * The three answers are not interchangeable. Folding `'unverified'` into
 * `'not-landed'` let a partition that blocked both the write and this read
 * delete the object a possibly-live row points at.
 */
describe('verifyRow', () => {
  it("reports 'landed' when the row carries this write's identity", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'r1' } });

    const result = await verifyRow({ client, tableName: 't' }, attributeProbe('r1'));

    expect(result.verdict).toBe('landed');
    expect(result.row).toEqual({ rev: 'r1' });
  });

  it("reports 'not-landed' for another identity, and hands back the row that holds it", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'other' } });

    const result = await verifyRow({ client, tableName: 't' }, attributeProbe('r1'));

    expect(result.verdict).toBe('not-landed');
    expect(result.row).toEqual({ rev: 'other' });
  });

  it("reports 'not-landed' when no row exists", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});

    await expect(verifyRow({ client, tableName: 't' }, attributeProbe('r1'))).resolves.toEqual({
      verdict: 'not-landed',
      row: undefined,
    });
  });

  it("reports 'unverified' when the read itself fails, establishing nothing", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));

    await expect(verifyRow({ client, tableName: 't' }, attributeProbe('r1'))).resolves.toEqual({
      verdict: 'unverified',
    });
  });

  /** Nothing to compare means nothing at stake, so no read capacity is spent. */
  it('answers without reading when the probe has no expected identity', async () => {
    const { client, mock } = createStrictDocumentMock();

    await expect(verifyRow({ client, tableName: 't' }, attributeProbe(undefined))).resolves.toEqual(
      { verdict: 'not-landed' },
    );
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('reads strongly consistently and projects only what the probe names', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'r1' } });

    await verifyRow({ client, tableName: 't' }, { ...attributeProbe('r1'), also: ['value'] });

    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.ConsistentRead).toBe(true);
    expect(input.Key).toEqual(KEY);
    expect(Object.values(input.ExpressionAttributeNames!)).toEqual(['rev', 'value']);
  });
});

describe('verdictFor', () => {
  /** A guard rejection carries the row that turned it away, so no read is needed. */
  it('judges a row already in hand without touching DynamoDB', () => {
    expect(verdictFor(attributeProbe('r1'), { rev: 'r1' })).toBe('landed');
    expect(verdictFor(attributeProbe('r1'), { rev: 'other' })).toBe('not-landed');
    expect(verdictFor(attributeProbe('r1'), undefined)).toBe('not-landed');
  });
});

describe('readRow', () => {
  it('rejects with the underlying error, so a caller can report the cause', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));

    await expect(readRow({ client, tableName: 't' }, attributeProbe('r1'))).rejects.toThrow('down');
  });
});
