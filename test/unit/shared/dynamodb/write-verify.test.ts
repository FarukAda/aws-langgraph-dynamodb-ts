import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import {
  identityOf,
  offloadedKey,
  readRow,
  type RowProbe,
  type RowRead,
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

/** The projection `readRow` sends for `read`, and the attribute names it declares. */
async function projectionFor(read: RowRead) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(GetCommand).resolves({});
  await readRow({ client, tableName: 't' }, read);
  const input = mock.commandCalls(GetCommand)[0].args[0].input;
  return { expression: input.ProjectionExpression, names: input.ExpressionAttributeNames };
}

/**
 * A cleanup decision needs where a payload lives, never its inline bytes. The
 * projection must also stay one DynamoDB accepts: it refuses an attribute name
 * the expression does not use, and two document paths that overlap.
 */
describe('readRow descriptor projection', () => {
  it('projects a descriptor attribute as its location and s3Key only', async () => {
    await expect(
      projectionFor({ key: KEY, attribute: 'rev', descriptors: ['value'] }),
    ).resolves.toEqual({
      expression: '#a0, #d0.#loc, #d0.#s3k',
      names: { '#a0': 'rev', '#d0': 'value', '#loc': 'location', '#s3k': 's3Key' },
    });
  });

  it('projects an attribute also named as a descriptor once, as the descriptor', async () => {
    await expect(
      projectionFor({ key: KEY, attribute: 'metadata', descriptors: ['metadata'] }),
    ).resolves.toEqual({
      expression: '#d0.#loc, #d0.#s3k',
      names: { '#d0': 'metadata', '#loc': 'location', '#s3k': 's3Key' },
    });
    await expect(
      projectionFor({ key: KEY, attribute: 'rev', also: ['value'], descriptors: ['value'] }),
    ).resolves.toEqual({
      expression: '#a0, #d0.#loc, #d0.#s3k',
      names: { '#a0': 'rev', '#d0': 'value', '#loc': 'location', '#s3k': 's3Key' },
    });
  });

  it('projects exactly as before when no descriptor is named', async () => {
    await expect(projectionFor({ key: KEY, attribute: 'rev', also: ['value'] })).resolves.toEqual({
      expression: '#a0, #a1',
      names: { '#a0': 'rev', '#a1': 'value' },
    });
    await expect(projectionFor({ key: KEY, attribute: 'PK' })).resolves.toEqual({
      expression: '#a0',
      names: { '#a0': 'PK' },
    });
  });

  /** The nested projection still hands the attribute back as a map, so the probe reads its key. */
  it('reads the identity of a descriptor projected as its location and s3Key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: { location: 'S3', s3Key: 'k' } } });
    await expect(
      verifyRow({ client, tableName: 't' }, { ...descriptorProbe('k'), descriptors: ['value'] }),
    ).resolves.toMatchObject({ verdict: 'landed' });
  });
});
