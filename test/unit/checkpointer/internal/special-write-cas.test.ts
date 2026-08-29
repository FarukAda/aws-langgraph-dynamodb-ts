import { writeSpecialItem } from '../../../../src/checkpointer/internal/special-write-cas';
import { readSpecialRow } from '../../../../src/checkpointer/internal/special-write-verify';
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

const retryExhausted = () =>
  Object.assign(new Error('Operation failed after 5 attempts: timeout'), {
    name: 'RetryExhaustedError',
  });

const queuedReads = (reads: unknown[]) => async () => {
  const next = reads.shift();
  if (next === undefined) throw new Error('read failed');
  return next;
};

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
      offloader: {},
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
      offloader: {},
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

  it('does not delete its own just-committed payload when a lost put response looks like a competitor win', async () => {
    // Attempt 1's PutCommand actually committed server-side, but the response
    // was lost (ECONNRESET etc.) and withDynamoDBRetry retried the guarded
    // put — which now sees its OWN just-written row and fails the condition,
    // indistinguishable from a competitor's win. The re-read finds the row
    // already holding this call's own writeGroup ('g2', matching
    // item().writeGroup), so the write must report having superseded
    // whatever the FIRST read pinned ('old'), never the item's own value.
    const seen = [
      { Item: { value: descriptor('old'), writeGroup: 'g1' } },
      { Item: { value: descriptor('new'), writeGroup: 'g2' } },
    ];
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
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

    expect(puts).toBe(1);
    expect(outcome).toEqual({ committed: true, superseded: descriptor('old') });
  });

  it('reports a definite failure without claiming a commit', async () => {
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
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

  it('never rejects, so a concurrent Promise.all branch still settles, without attempting a put', async () => {
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
      client: {
        get: async () => {
          throw new Error('read failed');
        },
        put: async () => {
          puts += 1;
          return {};
        },
      },
    };

    await expect(writeSpecialItem(context as never, item())).resolves.toMatchObject({
      committed: false,
    });
    expect(puts).toBe(0);
  });

  it('exhausts the compare-and-swap budget and falls back to an unconditional overwrite', async () => {
    const warnings: unknown[][] = [];
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: { ...SILENT_LOGGER, warn: (...args: unknown[]) => warnings.push(args) },
      offloader: {},
      client: {
        // 'competitor-N' never collides with item().writeGroup ('g2').
        get: async () => ({
          Item: { value: descriptor('theirs'), writeGroup: `competitor-${puts}` },
        }),
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

  it('skips the compare-and-swap and writes unconditionally when no offloader is configured', async () => {
    // Without an offloader there is no S3 object to orphan, so the read that
    // exists purely to feed the CAS guard is skipped entirely — matching
    // store/internal/persist.ts's own offloader gate.
    let gets = 0;
    const inputs: Record<string, unknown>[] = [];
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      client: {
        get: async () => {
          gets += 1;
          return {};
        },
        put: async (input: Record<string, unknown>) => {
          inputs.push(input);
          return {};
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(gets).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].ConditionExpression).toBeUndefined();
    expect(outcome).toEqual({ committed: true });
  });

  it('confirms the commit by re-reading when a lost response exhausts the retries without a rejection', async () => {
    // The guarded put commits server-side but its response is lost;
    // withDynamoDBRetry re-issues, and every re-issue times out at the
    // transport without reaching DynamoDB, so the budget is spent on a
    // RetryExhaustedError and never on a ConditionalCheckFailedException.
    // Reporting that as a confirmed non-commit made putWrites delete the S3
    // object the now-live row points at, so every later getTuple() on that
    // checkpoint failed with NoSuchKey, permanently.
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
      client: {
        get: queuedReads([
          { Item: { value: descriptor('old'), writeGroup: 'g1' } },
          { Item: { value: descriptor('new'), writeGroup: 'g2' } },
        ]),
        put: async () => {
          throw retryExhausted();
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(outcome).toEqual({ committed: true, superseded: descriptor('old') });
  });

  it('reports a commit, and no superseded payload, when the verification read itself fails', async () => {
    // Nothing is confirmed, so the outcome must not license deleting this
    // item's own upload: leak an object, never strand a live row.
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
      client: {
        get: queuedReads([{ Item: { value: descriptor('old'), writeGroup: 'g1' } }]),
        put: async () => {
          throw retryExhausted();
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(outcome.committed).toBe(true);
    expect(outcome.superseded).toBeUndefined();
    expect(outcome.error?.name).toBe('RetryExhaustedError');
  });

  it('reports a commit when a rejection is caught but the classifying re-read fails', async () => {
    // Second door to the same stranded row: the put landed, the retry produced
    // a ConditionalCheckFailedException, and readSpecialRow then threw.
    const context = {
      tableName: 'c',
      logger: SILENT_LOGGER,
      offloader: {},
      client: {
        get: queuedReads([{ Item: { value: descriptor('old'), writeGroup: 'g1' } }]),
        put: async () => {
          throw conditionalFailure();
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(outcome.committed).toBe(true);
    expect(outcome.superseded).toBeUndefined();
    expect(outcome.error?.name).toBe('ConditionalCheckFailedException');
  });

  it('confirms the commit when the unconditional fallback overwrite loses its response too', async () => {
    let puts = 0;
    const context = {
      tableName: 'c',
      logger: { ...SILENT_LOGGER, warn: () => undefined },
      offloader: {},
      client: {
        get: queuedReads([
          { Item: { value: descriptor('theirs'), writeGroup: 'competitor-0' } },
          { Item: { value: descriptor('theirs'), writeGroup: 'competitor-1' } },
          { Item: { value: descriptor('theirs'), writeGroup: 'competitor-2' } },
          { Item: { value: descriptor('theirs'), writeGroup: 'competitor-3' } },
          { Item: { value: descriptor('new'), writeGroup: 'g2' } },
        ]),
        put: async () => {
          puts += 1;
          throw puts <= OVERWRITE_CAS_MAX_ATTEMPTS ? conditionalFailure() : retryExhausted();
        },
      },
    };

    const outcome = await writeSpecialItem(context as never, item());

    expect(puts).toBe(OVERWRITE_CAS_MAX_ATTEMPTS + 1);
    expect(outcome).toEqual({ committed: true, superseded: descriptor('theirs') });
  });
});
