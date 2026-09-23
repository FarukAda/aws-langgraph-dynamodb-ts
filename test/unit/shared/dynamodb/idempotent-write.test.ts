import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { MAX_WRITE_LIFETIME_MS } from '../../../../src/shared/constants';
import { REVISION_ATTRIBUTE, revisionGuard } from '../../../../src/shared/dynamodb/conditional-put';
import {
  deleteIdempotently,
  type IdempotentWriteDeps,
  putIdempotently,
  referencesS3Object,
  transactIdempotently,
} from '../../../../src/shared/dynamodb/idempotent-write';
import * as retryModule from '../../../../src/shared/dynamodb/retry';
import type { RetryOptions } from '../../../../src/shared/dynamodb/retry';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const TABLE = 'adapter-table';
const ITEM = {
  PK: 'p',
  SK: 's',
  value: { location: PayloadLocation.S3, s3Key: 'k', serdeType: 'json', compressed: false },
};
const KEY = { PK: 'p', SK: 's' };

const throttled = (): Error =>
  Object.assign(new Error('slow down'), { name: 'ThrottlingException' });

/** A policy whose backoff sleeps for no time at all, so a retry costs the suite nothing. */
const instantPolicy = (overrides: RetryOptions = {}): RetryOptions => ({
  maxAttempts: 4,
  baseDelayMs: 10,
  maxDelayMs: 10,
  rng: () => 0,
  ...overrides,
});

let client: IdempotentWriteDeps['client'];
let mock: ReturnType<typeof createStrictDocumentMock>['mock'];

beforeEach(() => {
  ({ client, mock } = createStrictDocumentMock());
});

afterEach(() => {
  mock.restore();
});

const emitted = (): TransactWriteCommandInput[] =>
  mock.commandCalls(TransactWriteCommand).map((call) => call.args[0].input);

type TransactPut = NonNullable<
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Put']
>;

const putOf = (input: TransactWriteCommandInput): TransactPut | undefined =>
  input.TransactItems?.[0]?.Put;

type TransactDelete = NonNullable<
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Delete']
>;

const deleteOf = (input: TransactWriteCommandInput): TransactDelete | undefined =>
  input.TransactItems?.[0]?.Delete;

describe('referencesS3Object', () => {
  it('answers only for a descriptor whose payload was offloaded', () => {
    expect(referencesS3Object({ location: PayloadLocation.S3, s3Key: 'k' })).toBe(true);
    expect(referencesS3Object({ location: PayloadLocation.INLINE })).toBe(false);
    /**
     * The location alone decides, and a key-less offloaded descriptor is the
     * case that says so. Requiring the key here - aligning this with
     * collectS3Keys, which does require one - would route such a row back onto
     * the untokened put, which is the write this helper exists to replace.
     */
    expect(referencesS3Object({ location: PayloadLocation.S3 })).toBe(true);
  });
});

describe('putIdempotently', () => {
  it("puts one guarded item, carrying the guard's fragments and its ALL_OLD request", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const deps = { client, tableName: TABLE, retry: instantPolicy() };

    await putIdempotently(
      deps,
      ITEM,
      revisionGuard(REVISION_ATTRIBUTE, {
        exists: true,
        revision: 'r1',
      }),
    );

    const [input] = emitted();
    expect(input.TransactItems).toHaveLength(1);
    expect(putOf(input)).toEqual({
      TableName: TABLE,
      Item: ITEM,
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': REVISION_ATTRIBUTE },
      ExpressionAttributeValues: { ':rev': 'r1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(input.ClientRequestToken).toHaveLength(36);
  });

  it('puts an unguarded item when the caller pins nothing', async () => {
    mock.on(TransactWriteCommand).resolves({});

    await putIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, ITEM);

    expect(putOf(emitted()[0])).toEqual({ TableName: TABLE, Item: ITEM });
  });

  it('re-sends the one request, token included, for every attempt of one budget', async () => {
    mock.on(TransactWriteCommand).rejectsOnce(throttled()).resolves({});

    await putIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, ITEM);

    const inputs = emitted();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].ClientRequestToken).toBe(inputs[1].ClientRequestToken);
    expect(inputs[0]).toBe(inputs[1]);
  });

  /**
   * A compare-and-swap re-pin sends a different condition under the same
   * 10-minute window, which the service refuses when the token is reused. The
   * refusal cannot be provoked here, so what is asserted is the thing that
   * prevents it: the two emitted requests carry different tokens.
   */
  it('draws a fresh token for a re-pinned write', async () => {
    mock.on(TransactWriteCommand).resolves({});
    const deps = { client, tableName: TABLE, retry: instantPolicy() };

    await putIdempotently(deps, ITEM, revisionGuard(REVISION_ATTRIBUTE, { exists: false }));
    await putIdempotently(
      deps,
      ITEM,
      revisionGuard(REVISION_ATTRIBUTE, {
        exists: true,
        revision: 'r2',
      }),
    );

    const inputs = emitted();
    expect(inputs).toHaveLength(2);
    expect(putOf(inputs[0])).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)' });
    expect(putOf(inputs[1])).toMatchObject({ ConditionExpression: '#rev = :rev' });
    expect(inputs[0].ClientRequestToken).not.toBe(inputs[1].ClientRequestToken);
  });

  it("bounds this call without stamping a deadline on the adapter's own policy", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const policy = instantPolicy();
    const deps = { client, tableName: TABLE, retry: policy };
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await putIdempotently(deps, ITEM);

    const passed = spy.mock.calls[0][1];
    expect(passed).toEqual({ ...policy, deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS });
    expect(passed).not.toBe(policy);
    expect(policy).not.toHaveProperty('deadlineAt');
    expect(deps.retry).toBe(policy);
  });

  /**
   * The contrast is the whole test: one policy, two jitter draws. The draw that
   * lands a sleep exactly on the lifetime ends the budget after one attempt;
   * the draw that sleeps for no time at all spends every attempt. Only a
   * deadline of this call's own makes the first of those differ from the second.
   */
  it('ends the budget rather than sleeping past the write lifetime', async () => {
    mock.on(TransactWriteCommand).rejects(throttled());
    /**
     * Half of twice the lifetime, rather than all of it once: `fullJitter`
     * returns `rng() * delayMs` and documents `rng` as `[0, 1)`, so `1` is the
     * one draw the seam promises never to make. This lands the same boundary
     * from inside the contract.
     */
    const onTheLimit = instantPolicy({
      baseDelayMs: 2 * MAX_WRITE_LIFETIME_MS,
      maxDelayMs: 2 * MAX_WRITE_LIFETIME_MS,
      rng: () => 0.5,
    });

    await expect(
      putIdempotently({ client, tableName: TABLE, retry: onTheLimit }, ITEM),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(emitted()).toHaveLength(1);

    mock.resetHistory();
    await expect(
      putIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, ITEM),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(emitted()).toHaveLength(4);
  });

  it("carries the caller's abort signal into the budget", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      putIdempotently(
        { client, tableName: TABLE, retry: instantPolicy() },
        ITEM,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(emitted()).toHaveLength(0);
  });
});

describe('deleteIdempotently', () => {
  it("removes one guarded key, carrying the guard's fragments and its ALL_OLD request", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const deps = { client, tableName: TABLE, retry: instantPolicy() };

    await deleteIdempotently(
      deps,
      KEY,
      revisionGuard(REVISION_ATTRIBUTE, { exists: true, revision: 'r1' }),
    );

    const [input] = emitted();
    expect(input.TransactItems).toHaveLength(1);
    expect(deleteOf(input)).toEqual({
      TableName: TABLE,
      Key: KEY,
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': REVISION_ATTRIBUTE },
      ExpressionAttributeValues: { ':rev': 'r1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(input.ClientRequestToken).toHaveLength(36);
    /** The one action, and nothing of the put's shape alongside it. */
    expect(input.TransactItems?.[0].Put).toBeUndefined();
  });

  it('removes an unguarded key when the caller pins nothing', async () => {
    mock.on(TransactWriteCommand).resolves({});

    await deleteIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, KEY);

    expect(deleteOf(emitted()[0])).toEqual({ TableName: TABLE, Key: KEY });
  });

  it('re-sends the one request, token included, for every attempt of one budget', async () => {
    mock.on(TransactWriteCommand).rejectsOnce(throttled()).resolves({});

    await deleteIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, KEY);

    const inputs = emitted();
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toBe(inputs[1]);
    expect(inputs[0].ClientRequestToken).toBe(inputs[1].ClientRequestToken);
  });

  /**
   * A cancelled token reserves its parameters on real DynamoDB, so the re-pin
   * that follows a lost compare-and-swap must draw a new one or be refused with
   * `IdempotentParameterMismatchException`. The refusal is an AWS-tier
   * observation; what is asserted here is the thing that prevents it.
   */
  it('draws a fresh token for a re-pinned delete', async () => {
    mock.on(TransactWriteCommand).resolves({});
    const deps = { client, tableName: TABLE, retry: instantPolicy() };

    await deleteIdempotently(deps, KEY, revisionGuard(REVISION_ATTRIBUTE, { exists: true }));
    await deleteIdempotently(
      deps,
      KEY,
      revisionGuard(REVISION_ATTRIBUTE, { exists: true, revision: 'r2' }),
    );

    const inputs = emitted();
    expect(deleteOf(inputs[0])).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#rev)',
    });
    expect(deleteOf(inputs[1])).toMatchObject({ ConditionExpression: '#rev = :rev' });
    expect(inputs[0].ClientRequestToken).not.toBe(inputs[1].ClientRequestToken);
  });

  it("bounds this call without stamping a deadline on the adapter's own policy", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const policy = instantPolicy();
    const deps = { client, tableName: TABLE, retry: policy };
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await deleteIdempotently(deps, KEY);

    expect(spy.mock.calls[0][1]).toEqual({
      ...policy,
      deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS,
    });
    expect(policy).not.toHaveProperty('deadlineAt');
  });

  it("carries the caller's abort signal into the budget", async () => {
    mock.on(TransactWriteCommand).resolves({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      deleteIdempotently(
        { client, tableName: TABLE, retry: instantPolicy() },
        KEY,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(emitted()).toHaveLength(0);
  });
});

describe('transactIdempotently', () => {
  /**
   * The generalisation the other two rest on. A caller with two rows that must
   * land together - the checkpoint's META and PAYLOAD pair - sends them as the
   * actions of one transaction rather than as two calls, and gets the same
   * single token and the same deadline the one-action callers get.
   */
  it('sends every action it is given, in order, under one token', async () => {
    mock.on(TransactWriteCommand).resolves({});
    const second = { ...ITEM, SK: 's2' };

    await transactIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, [
      { Put: { TableName: TABLE, Item: ITEM } },
      { Put: { TableName: TABLE, Item: second } },
    ]);

    const [input] = emitted();
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems?.map((action) => action.Put?.Item)).toEqual([ITEM, second]);
    expect(input.ClientRequestToken).toHaveLength(36);
  });

  it('re-sends the one request, token included, for every attempt of one budget', async () => {
    mock.on(TransactWriteCommand).rejectsOnce(throttled()).resolves({});

    await transactIdempotently({ client, tableName: TABLE, retry: instantPolicy() }, [
      { Put: { TableName: TABLE, Item: ITEM } },
      { Put: { TableName: TABLE, Item: { ...ITEM, SK: 's2' } } },
    ]);

    const inputs = emitted();
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toBe(inputs[1]);
    expect(inputs[0].ClientRequestToken).toBe(inputs[1].ClientRequestToken);
  });
});
