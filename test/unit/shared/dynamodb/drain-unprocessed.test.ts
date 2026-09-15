import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { drainUnprocessedWrites } from '../../../../src/shared/dynamodb/drain-unprocessed';
import { BatchWriteIncompleteError } from '../../../../src/shared/errors/errors';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const put = (pk: string) => ({ PutRequest: { Item: { pk } } });

describe('drainUnprocessedWrites', () => {
  it('re-submits UnprocessedItems until empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { t: [put('a')] } })
      .resolvesOnce({ UnprocessedItems: {} });
    await expect(
      drainUnprocessedWrites(client, 't', [put('a')], { rng: () => 0 }),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('is a no-op for an empty request list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(drainUnprocessedWrites(client, 't', [])).resolves.toBeUndefined();
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('throws BatchWriteIncompleteError after the retry budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: { t: [put('a')] } });
    await expect(
      drainUnprocessedWrites(client, 't', [put('a')], { rng: () => 0, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(BatchWriteIncompleteError);
  });

  it('reports the confirmed persisted count when a retry hard-fails after an earlier partial drain', async () => {
    const { client, mock } = createStrictDocumentMock();
    // Round 1: 5 items in, 3 persist (a,b,c), 2 (d,e) come back unprocessed.
    // Round 2 (retrying d,e): the call itself throws instead of resolving —
    // e.g. withDynamoDBRetry exhausting its own budget under sustained
    // throttling. The 3 from round 1 must not be lost from the accounting.
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { t: [put('d'), put('e')] } })
      .rejectsOnce(Object.assign(new Error('throttled'), { name: 'RetryExhaustedError' }));
    const error = await drainUnprocessedWrites(
      client,
      't',
      [put('a'), put('b'), put('c'), put('d'), put('e')],
      { rng: () => 0 },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'BatchWriteIncompleteError',
      succeededCount: 3,
      unprocessed: [put('d'), put('e')],
    });
    expect((error as { cause?: Error }).cause?.message).toBe('throttled');
  });

  it('raises the AbortError unchanged when the signal aborts during backoff', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    // Round 1: 5 in, 3 persist (a,b,c), 2 (d,e) unprocessed — same partial
    // drain as above, but this time the caller's signal aborts during the
    // backoff wait before round 2 ever fires, instead of round 2 hard-failing.
    mock.on(BatchWriteCommand).callsFake(() => {
      controller.abort();
      return { UnprocessedItems: { t: [put('d'), put('e')] } };
    });
    const error = await drainUnprocessedWrites(
      client,
      't',
      [put('a'), put('b'), put('c'), put('d'), put('e')],
      { rng: () => 0, signal: controller.signal },
    ).catch((e: unknown) => e);
    /**
     * A cancelled drain is an abort. Reporting BATCH_WRITE_INCOMPLETE here
     * contradicted the ABORTED that every cancellable method documents, and
     * left a caller branching on the wrong code for their own cancellation.
     */
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORTED' });
  });
});

describe('the drain obeys the configured retry policy (CORE-04)', () => {
  /**
   * The wall clock is frozen for determinism, so the wait is asserted at the
   * timer rather than measured. `rng: () => 1` takes the top of the jitter
   * window, which makes the configured base exactly observable.
   */
  function recordDelays(): number[] {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, 0);
    }) as unknown as typeof setTimeout);
    return delays;
  }

  function onePartialRound(mock: ReturnType<typeof createStrictDocumentMock>['mock']): void {
    let rounds = 0;
    mock.on(BatchWriteCommand).callsFake(() => {
      rounds += 1;
      return rounds === 1 ? { UnprocessedItems: { t: [put('b')] } } : {};
    });
  }

  it('waits the configured base delay between rounds, not the module default', async () => {
    const { client, mock } = createStrictDocumentMock();
    onePartialRound(mock);
    const delays = recordDelays();
    await drainUnprocessedWrites(client, 't', [put('a'), put('b')], {
      retry: { baseDelayMs: 150 },
      rng: () => 1,
    });
    expect(delays).toEqual([150]);
  });

  it('falls back to the module default when no policy is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    onePartialRound(mock);
    const delays = recordDelays();
    await drainUnprocessedWrites(client, 't', [put('a'), put('b')], { rng: () => 1 });
    expect(delays).toEqual([100]);
  });
});
