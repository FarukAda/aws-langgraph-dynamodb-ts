import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import { assertRowFits } from '../../../../src/store/internal/item-write';
import type { StoreItemRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedPut } from '../../../shared/helpers/parsed-inputs';

const DIMS = 1536;
/** Seventeen significant digits, as a float64 embedding component has; a string literal avoids the precision-loss lint a numeric one would trigger. */
const SEED = Number('0.12345678901234567');
/** A vector whose every component has seventeen significant digits, as a float64 embedding does. */
const vector = (): number[] => Array.from({ length: DIMS }, (_, i) => SEED + i / 1e9);

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => `${[...parts, objectId].join('/')}.bin`,
    upload: jest.fn((key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}

function context(
  client: StoreContext['client'],
  offloader: ReturnType<typeof trackingOffloader>,
): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
    offloader: offloader as never,
    index: {
      dims: DIMS,
      fields: ['sections[*].text'],
      embeddings: {
        embedQuery: () => Promise.resolve(vector()),
        embedDocuments: (texts: string[]) => Promise.resolve(texts.map(() => vector())),
      },
    } as never,
  };
}

describe('store.put against the item limit', () => {
  it('refuses a row its inline vectors would push past 400 KB, before writing, and releases its upload', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const s3 = trackingOffloader();
    const sections = Array.from({ length: 50 }, (_, i) => ({ text: `section ${i}` }));
    await expect(
      putItem(
        context(client, s3),
        parsedPut({ namespace: ['docs'], key: 'd1', value: { sections } }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'index' } });
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(s3.deleteBatch).toHaveBeenCalledTimes(1);
  });

  it('writes a row with a few vectors', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    const s3 = trackingOffloader();
    const sections = Array.from({ length: 3 }, (_, i) => ({ text: `section ${i}` }));
    await expect(
      putItem(
        context(client, s3),
        parsedPut({ namespace: ['docs'], key: 'd1', value: { sections } }),
      ),
    ).resolves.toBeUndefined();
  });
});

/** A minimal row: small enough, on its own, to fit well under the item limit. */
const baseRow = (): StoreItemRow => ({
  PK: 'STORE#n',
  SK: 'k',
  namespace: ['n'],
  key: 'k',
  value: {
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: new Uint8Array(10),
  },
  createdAt: 'T0',
  updatedAt: 'T1',
});

describe('assertRowFits', () => {
  it('does not throw for a row within the limit', () => {
    expect(() => assertRowFits(baseRow())).not.toThrow();
  });

  it('throws VALIDATION naming index when the inline vectors are what push the row over', () => {
    // The bare row (payload plus keys and timestamps) is a few hundred bytes;
    // one 150,000-element vector alone is well past 400 KB, so it — and
    // nothing else on the row — is what crosses the limit.
    const row: StoreItemRow = {
      ...baseRow(),
      embeddings: [Array.from({ length: 150_000 }, () => 1)],
    };
    expect(() => assertRowFits(row)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'index' } }),
    );
  });

  it('throws VALIDATION naming value when the row is over the limit even without its vectors', () => {
    const row: StoreItemRow = {
      ...baseRow(),
      value: {
        location: PayloadLocation.INLINE,
        serdeType: 'json',
        compressed: false,
        bytes: new Uint8Array(420 * 1024),
      },
    };
    expect(() => assertRowFits(row)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'value' } }),
    );
  });
});
