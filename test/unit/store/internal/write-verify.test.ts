import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
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

describe('verifyWriteLanded', () => {
  it("reports 'landed' when the row already holds the expected S3 key", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'k.bin',
        },
      },
    });
    await expect(verifyWriteLanded(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      'landed',
    );
  });

  it("reports 'not-landed' when the row holds a different S3 key", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'other.bin',
        },
      },
    });
    await expect(verifyWriteLanded(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      'not-landed',
    );
  });

  it("reports 'not-landed' when the row does not exist", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(verifyWriteLanded(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      'not-landed',
    );
  });

  it("reports 'unverified', never 'not-landed', when the confirmation read itself fails", async () => {
    // Reporting a failed read as a confirmed non-commit is what let a
    // partition that blocked both the put and this read delete the S3 object
    // a live row points at.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(verifyWriteLanded(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      'unverified',
    );
  });
});

describe('rowIsAbsent (I4)', () => {
  it('returns true when the row is genuinely gone', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(rowIsAbsent(context(client), { PK: 'p', SK: 's' })).resolves.toBe(true);
  });

  it('returns false when the row is still present', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: {} } });
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
