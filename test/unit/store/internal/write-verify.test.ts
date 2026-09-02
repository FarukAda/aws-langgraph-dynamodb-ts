import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  isRetryExhausted,
  rowIsAbsent,
  verifyWriteLanded,
} from '../../../../src/store/internal/write-verify';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

const record = { PK: 'p', SK: 's', rev: 'r1' };

describe('verifyWriteLanded (STORE-13)', () => {
  it("reports 'landed' when the row holds this write's own rev, projecting only the rev", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { rev: 'r1' } });
    await expect(verifyWriteLanded(context(client), record)).resolves.toBe('landed');
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.ProjectionExpression).toBe('#r');
    expect(input.ExpressionAttributeNames).toEqual({ '#r': 'rev' });
    expect(input.ConsistentRead).toBe(true);
  });

  it("reports 'not-landed' when the row holds another rev or does not exist", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .resolvesOnce({ Item: { rev: 'other' } })
      .resolves({});
    await expect(verifyWriteLanded(context(client), record)).resolves.toBe('not-landed');
    await expect(verifyWriteLanded(context(client), record)).resolves.toBe('not-landed');
  });

  it("reports 'not-landed' without a read for a record that carries no rev", async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(verifyWriteLanded(context(client), { PK: 'p', SK: 's' })).resolves.toBe(
      'not-landed',
    );
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("reports 'unverified', never 'not-landed', when the confirmation read itself fails", async () => {
    // Reporting a failed read as a confirmed non-commit is what let a
    // partition that blocked both the put and this read delete the S3 object
    // a live row points at.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(verifyWriteLanded(context(client), record)).resolves.toBe('unverified');
  });
});

describe('rowIsAbsent (I4, STORE-07)', () => {
  it('returns true when the row is genuinely gone, projecting only the partition key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(rowIsAbsent(context(client), { PK: 'p', SK: 's' })).resolves.toBe(true);
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.ProjectionExpression).toBe('#pk');
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK' });
  });

  it('returns false when the row is still present', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'p' } });
    await expect(rowIsAbsent(context(client), { PK: 'p', SK: 's' })).resolves.toBe(false);
  });

  it('fails safe when the verification read itself fails', async () => {
    // A failed read is not evidence of absence: treating it as confirmation
    // would let cleanup run for a delete that may never have landed.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(rowIsAbsent(context(client), { PK: 'p', SK: 's' })).resolves.toBe(false);
  });

  it('recognises a retry-exhausted error by name, not instanceof', () => {
    expect(isRetryExhausted(Object.assign(new Error('x'), { name: 'RetryExhaustedError' }))).toBe(
      true,
    );
    expect(isRetryExhausted(new Error('x'))).toBe(false);
  });
});
