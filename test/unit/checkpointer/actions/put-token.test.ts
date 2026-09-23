import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { MAX_WRITE_LIFETIME_MS } from '../../../../src/shared/constants';
import { conditionalCheckFailure } from '../../../../src/shared/dynamodb/cancellation';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import * as retryModule from '../../../../src/shared/dynamodb/retry';
import type { RetryOptions } from '../../../../src/shared/dynamodb/retry';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };
const config = { configurable: { thread_id: 't1' } };

/** A policy whose backoff sleeps for no time at all, so a retry costs nothing. */
const instantPolicy = (): RetryOptions => ({
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 1,
  rng: () => 0,
});

const throttled = (): Error =>
  Object.assign(new Error('slow down'), { name: 'ThrottlingException' });

type DocumentMock = ReturnType<typeof createStrictDocumentMock>['mock'];

const emitted = (mock: DocumentMock): TransactWriteCommandInput[] =>
  mock.commandCalls(TransactWriteCommand).map((call) => call.args[0].input);

function contextWith(client: CheckpointerContext['client'], retry?: RetryOptions) {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER, retry } as CheckpointerContext;
}

describe('the checkpoint pair is sent once, under its own request token', () => {
  it('carries both rows and a 36-character token in one transaction', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});

    await putCheckpoint(contextWith(client), config, checkpoint, metadata);

    const [input] = emitted(mock);
    expect(input.TransactItems).toHaveLength(2);
    expect(input.ClientRequestToken).toHaveLength(36);
  });

  /**
   * Identity, not equality. A token minted on a request the retry closure
   * rebuilds buys nothing, because each attempt would draw its own and the
   * service would see two distinct requests; only one object re-sent
   * unchanged is deduplicated. This is the assertion the whole change exists
   * for, and rebuilding the input inside the closure fails it.
   */
  it('re-sends the identical request object for every attempt of one budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejectsOnce(throttled()).rejectsOnce(throttled()).resolves({});

    await putCheckpoint(contextWith(client, instantPolicy()), config, checkpoint, metadata);

    const inputs = emitted(mock);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toBe(inputs[1]);
    expect(inputs[1]).toBe(inputs[2]);
    expect(new Set(inputs.map((input) => input.ClientRequestToken)).size).toBe(1);
  });

  it("bounds this call without stamping a deadline on the adapter's own policy", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const policy = instantPolicy();
    const context = contextWith(client, policy);
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await putCheckpoint(context, config, checkpoint, metadata);

    const passed = spy.mock.calls[0][1];
    expect(passed).toEqual({ ...policy, deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS });
    expect(passed).not.toBe(policy);
    expect(policy).not.toHaveProperty('deadlineAt');
    expect(context.retry).toBe(policy);
  });

  it('guards neither row, so a race that does happen stays readable as one cause', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});

    await putCheckpoint(contextWith(client), config, checkpoint, metadata);

    for (const action of emitted(mock)[0].TransactItems ?? []) {
      expect(action.Put).not.toHaveProperty('ConditionExpression');
    }
    /**
     * Why it must stay that way: guarding both rows would make one genuine
     * race cancel with two `ConditionalCheckFailed` reasons, and the reader
     * every caller goes through refuses to name that a guard rejection - it
     * would surface as an unrecognised non-retryable error instead.
     */
    expect(
      conditionalCheckFailure({
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'ConditionalCheckFailed' },
        ],
      }),
    ).toBeUndefined();
  });
});

/** The request the checkpoint transaction takes, as a hand-rolled double reads it. */
interface TransactInput {
  TransactItems: { Put: { Item: DocItem } }[];
  ClientRequestToken?: string;
}

/**
 * A table double honouring a request token the way the service does, with the
 * thread's deletion landing between the commit and the retry.
 *
 * The interleaving is the one this closes: the transaction applies both rows,
 * a concurrent `deleteThread` removes them and releases the objects they name,
 * and only then is the acknowledgement lost. Under a token the retry of the
 * identical request is answered from the idempotency cache; with no token, or
 * with a fresh one per attempt, it puts both rows back - live rows naming two
 * deleted objects, which no later read can recover from.
 */
function racedByAThreadDelete() {
  const applied = new Set<string>();
  const rows = new Map<string, DocItem>();
  let requests = 0;
  const client = {
    transactWrite: (input: TransactInput): Record<string, never> => {
      requests += 1;
      const token = input.ClientRequestToken;
      if (token !== undefined && applied.has(token)) return {};
      if (token !== undefined) applied.add(token);
      for (const action of input.TransactItems)
        rows.set(String(action.Put.Item.SK), action.Put.Item);
      if (requests > 1) return {};
      rows.clear();
      throw Object.assign(new Error('connection reset'), { name: 'ECONNRESET' });
    },
  };
  return {
    context: contextWith(client as never, instantPolicy()),
    surviving: () => rows.size,
    requests: () => requests,
  };
}

describe('a lost acknowledgement whose retry would re-land the pair', () => {
  it('leaves both rows a concurrent thread deletion removed deleted', async () => {
    const table = racedByAThreadDelete();

    await expect(putCheckpoint(table.context, config, checkpoint, metadata)).resolves.toEqual({
      configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'ckpt-1' },
    });

    expect(table.requests()).toBe(2);
    expect(table.surviving()).toBe(0);
  });
});
