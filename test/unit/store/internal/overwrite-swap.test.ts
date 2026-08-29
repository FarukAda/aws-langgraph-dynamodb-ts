import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putWithRevisionSwap } from '../../../../src/store/internal/overwrite-swap';
import type { ExistingRecordMeta } from '../../../../src/store/internal/read-existing';
import type { StoreItemRecord } from '../../../../src/store/types';

const descriptor = (s3Key: string) => ({
  location: PayloadLocation.S3 as const,
  serdeType: 'json',
  compressed: false,
  s3Key,
});

const record = (): StoreItemRecord => ({
  PK: 'STORE#n',
  SK: 'k',
  namespace: ['n'],
  key: 'k',
  value: descriptor('new'),
  createdAt: 'T0',
  updatedAt: 'T1',
  rev: 'mine',
});

const conditionalFailure = () =>
  Object.assign(new Error('rejected'), { name: 'ConditionalCheckFailedException' });

function harness(options: {
  failures: number;
  reReads: ExistingRecordMeta[];
  logger?: typeof SILENT_LOGGER;
}) {
  let puts = 0;
  const inputs: Record<string, unknown>[] = [];
  const context = {
    tableName: 'store',
    offloader: {},
    logger: options.logger ?? SILENT_LOGGER,
    client: {
      put: async (input: Record<string, unknown>) => {
        inputs.push(input);
        puts += 1;
        if (puts <= options.failures) throw conditionalFailure();
        return {};
      },
      get: async () => {
        const next = options.reReads.shift();
        return {
          Item: next?.exists
            ? { createdAt: next.createdAt, value: next.value, rev: next.revision }
            : undefined,
        };
      },
    },
  };
  return { context, inputs, putCount: () => puts };
}

describe('putWithRevisionSwap', () => {
  it('commits on the first attempt and reports what it superseded', async () => {
    const { context, inputs } = harness({ failures: 0, reReads: [] });
    const previous: ExistingRecordMeta = {
      exists: true,
      revision: 'r0',
      value: descriptor('old'),
      createdAt: 'T0',
    };

    const superseded = await putWithRevisionSwap(context as never, record(), previous);

    expect(superseded.value).toEqual(descriptor('old'));
    expect(inputs[0].ConditionExpression).toBe('#rev = :rev');
    expect(inputs[0].ExpressionAttributeValues).toEqual({ ':rev': 'r0' });
  });

  it('re-reads and retries when another writer won the row', async () => {
    // The whole point: the racer must supersede what is *actually* there now,
    // not the stale descriptor it first read — otherwise both delete the same
    // object and one upload is orphaned.
    const { context, inputs, putCount } = harness({
      failures: 1,
      reReads: [{ exists: true, revision: 'r1', value: descriptor('theirs'), createdAt: 'T0' }],
    });

    const superseded = await putWithRevisionSwap(context as never, record(), {
      exists: true,
      revision: 'r0',
      value: descriptor('old'),
      createdAt: 'T0',
    });

    expect(putCount()).toBe(2);
    expect(superseded.value).toEqual(descriptor('theirs'));
    expect(inputs[1].ExpressionAttributeValues).toEqual({ ':rev': 'r1' });
  });

  it('preserves createdAt discovered on a re-read', async () => {
    const { context } = harness({
      failures: 1,
      reReads: [{ exists: true, revision: 'r1', value: undefined, createdAt: 'ORIGINAL' }],
    });
    const item = record();

    await putWithRevisionSwap(context as never, item, { exists: false });

    expect(item.createdAt).toBe('ORIGINAL');
  });

  it('falls back to an unconditional write after the attempt bound, and warns', async () => {
    const warn = jest.fn();
    const { context, inputs, putCount } = harness({
      failures: 3,
      reReads: [
        { exists: true, revision: 'r1' },
        { exists: true, revision: 'r2' },
        { exists: true, revision: 'r3' },
      ],
      logger: { ...SILENT_LOGGER, warn },
    });

    await putWithRevisionSwap(context as never, record(), { exists: true, revision: 'r0' });

    expect(putCount()).toBe(4);
    expect(inputs[3].ConditionExpression).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('compare-and-swap'),
      expect.anything(),
    );
  });

  it('propagates a non-conditional error untouched', async () => {
    const context = {
      tableName: 'store',
      offloader: {},
      logger: SILENT_LOGGER,
      client: {
        put: async () => {
          throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
        },
        get: async () => ({ Item: undefined }),
      },
    };

    await expect(
      putWithRevisionSwap(context as never, record(), { exists: false }),
    ).rejects.toThrow('boom');
  });
});
