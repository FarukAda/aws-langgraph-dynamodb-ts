import {
  readSpecialRow,
  writeSpecialItem,
} from '../../../../src/checkpointer/internal/special-write-cas';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../../../src/shared/dynamodb/conditional-put';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

const descriptor = (s3Key: string) => ({
  location: PayloadLocation.S3 as const,
  serdeType: 'json',
  compressed: false,
  s3Key,
});

const item = (): CheckpointWriteItem => ({
  PK: 'CHKPT#t',
  SK: 'WRITE##c1#task#0000000007#__error__',
  taskId: 'task',
  index: -1,
  channel: '__error__',
  writeGroup: 'g2',
  occurrence: 0,
  value: descriptor('new'),
});

const conditionalFailure = () =>
  Object.assign(new Error('rejected'), { name: 'ConditionalCheckFailedException' });

describe('readSpecialRow', () => {
  it('reports an absent row', async () => {
    const context = { tableName: 'c', logger: SILENT_LOGGER, client: { get: async () => ({}) } };
    await expect(readSpecialRow(context as never, item())).resolves.toEqual({ exists: false });
  });

  it('reports the descriptor and the writeGroup that guards it', async () => {
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: { get: async () => ({ Item: { value: descriptor('old'), writeGroup: 'g1' } }) },
    };
    await expect(readSpecialRow(context as never, item())).resolves.toEqual({
      exists: true,
      value: descriptor('old'),
      revision: 'g1',
    });
  });
});

describe('writeSpecialItem', () => {
  it('commits against the observed writeGroup and reports what it superseded', async () => {
    const inputs: Record<string, unknown>[] = [];
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: {
        get: async () => ({ Item: { value: descriptor('old'), writeGroup: 'g1' } }),
        put: async (input: Record<string, unknown>) => {
          inputs.push(input);
          return {};
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(outcome).toEqual({ committed: true, superseded: descriptor('old') });
    expect(inputs[0].ConditionExpression).toBe('#rev = :rev');
    expect(inputs[0].ExpressionAttributeNames).toEqual({ '#rev': 'writeGroup' });
    expect(inputs[0].ExpressionAttributeValues).toEqual({ ':rev': 'g1' });
  });

  it('re-reads and retries when a racer replaced the row', async () => {
    const seen = [
      { Item: { value: descriptor('old'), writeGroup: 'g1' } },
      { Item: { value: descriptor('theirs'), writeGroup: 'g9' } },
    ];
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: {
        get: async () => seen.shift() ?? {},
        put: async () => {
          puts += 1;
          if (puts === 1) throw conditionalFailure();
          return {};
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(puts).toBe(2);
    expect(outcome.superseded).toEqual(descriptor('theirs'));
  });

  it('reports a definite failure without claiming a commit', async () => {
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: {
        get: async () => ({}),
        put: async () => {
          throw Object.assign(new Error('boom'), { name: 'ResourceNotFoundException' });
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(outcome.committed).toBe(false);
    expect(outcome.error?.message).toBe('boom');
  });

  it('never rejects, so a concurrent Promise.all branch still settles', async () => {
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: {
        get: async () => {
          throw new Error('read failed');
        },
        put: async () => ({}),
      },
    };

    await expect(writeSpecialItem(context as never, item())).resolves.toMatchObject({
      committed: false,
    });
  });

  it('exhausts the compare-and-swap budget and falls back to an unconditional overwrite', async () => {
    const warnings: unknown[][] = [];
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: { ...SILENT_LOGGER, warn: (...args: unknown[]) => warnings.push(args) },
      client: {
        get: async () => ({ Item: { value: descriptor('theirs'), writeGroup: `g${puts}` } }),
        put: async (input: Record<string, unknown>) => {
          puts += 1;
          if (puts <= OVERWRITE_CAS_MAX_ATTEMPTS) throw conditionalFailure();
          // The fallback put is unconditional: no ConditionExpression.
          expect(input.ConditionExpression).toBeUndefined();
          return {};
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(puts).toBe(OVERWRITE_CAS_MAX_ATTEMPTS + 1);
    expect(outcome).toEqual({ committed: true, superseded: descriptor('theirs') });
    expect(warnings).toHaveLength(1);
  });
});
