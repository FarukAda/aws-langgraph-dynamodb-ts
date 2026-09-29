import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
  type PutBucketLifecycleConfigurationCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import {
  ensureLifecycleRule,
  LIFECYCLE_SETTLE_WRITES,
} from '../../../../../src/shared/codec/s3/lifecycle';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../../src/shared/logging/logger';
import { fastLifecyclePoll, lifecycleBucket } from '../../../../shared/helpers/lifecycle-bucket';

const s3Mock = mockClient(S3Client);
beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
});

const client = () => new S3Client({ region: 'us-east-1' });
const target = { bucket: 'b', prefix: 'langgraph-checkpoints/store/', days: 3 };
const instant = { wait: () => Promise.resolve() };
const foreign: LifecycleRule = {
  ID: 'someone-else',
  Filter: { Prefix: 'other/' },
  Status: 'Enabled',
  Expiration: { Days: 9 },
};

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('ensureLifecycleRule reads back what it wrote', () => {
  it('converges at the first re-read: writes once and stops', async () => {
    const writes = lifecycleBucket(s3Mock);
    await ensureLifecycleRule(client(), target, SILENT_LOGGER, instant);
    expect(writes).toHaveLength(1);
    expect(s3Mock.commandCalls(GetBucketLifecycleConfigurationCommand)).toHaveLength(2);
  });

  it('lag, then converged, needs no extra write', async () => {
    let reads = 0;
    const written: LifecycleRule[][] = [];
    const logger = fakeLogger();
    // Reads 1 and 2 both show the pre-write state — this call's own first
    // write has not propagated yet. Read 3 finally echoes it.
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      if (reads <= 2) return { Rules: [] };
      return { Rules: written[written.length - 1] };
    });
    s3Mock
      .on(PutBucketLifecycleConfigurationCommand)
      .callsFake((input: PutBucketLifecycleConfigurationCommandInput) => {
        written.push(input.LifecycleConfiguration?.Rules ?? []);
        return {};
      });
    await ensureLifecycleRule(client(), target, logger, instant);
    expect(written).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('still shows what was there before this write'),
      { attempt: 1, waitedMs: 1000 },
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('lag through the whole window: warns, returns, and writes exactly once', async () => {
    const waits: number[] = [];
    const logger = fakeLogger();
    // A fixed, unchanging read: this call's own write is never visible to
    // it within the polling window, which is propagation lag rather than a
    // competing writer replacing the configuration with something else.
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await expect(
      ensureLifecycleRule(client(), target, logger, {
        wait: (delayMs) => {
          waits.push(delayMs);
          return Promise.resolve();
        },
      }),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'wrote the lifecycle rules but a re-read did not show them within the polling window',
      ),
      { bucket: 'b', prefix: target.prefix },
    );
    // The versioning report still runs on a lag exit.
    expect(s3Mock.commandCalls(GetBucketVersioningCommand)).toHaveLength(1);
  });

  /**
   * Lag on every re-read but the last, which then finds a genuinely different
   * configuration. Only two writes ever happen, so this is not `CONTENTION`,
   * which needs every one of the five rounds to write — it ends exactly like
   * a lag exit, because this call cannot tell "a rival replaced it once more"
   * from "this write itself merely is not visible yet" from here.
   */
  it('a rewrite only at the last round ends like lag: warns, returns, after fewer than five writes', async () => {
    let reads = 0;
    const written: LifecycleRule[][] = [];
    const logger = fakeLogger();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      if (reads <= 4) return { Rules: [] };
      return { Rules: [foreign] };
    });
    s3Mock
      .on(PutBucketLifecycleConfigurationCommand)
      .callsFake((input: PutBucketLifecycleConfigurationCommandInput) => {
        written.push(input.LifecycleConfiguration?.Rules ?? []);
        return {};
      });
    await expect(ensureLifecycleRule(client(), target, logger, instant)).resolves.toBeUndefined();
    expect(written).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'wrote the lifecycle rules but a re-read did not show them within the polling window',
      ),
      { bucket: 'b', prefix: target.prefix },
    );
    expect(s3Mock.commandCalls(GetBucketVersioningCommand)).toHaveLength(1);
  });

  it("writes its rules again, beside the other writer's, when a concurrent write replaced them", async () => {
    let reads = 0;
    const written: LifecycleRule[][] = [];
    const logger = fakeLogger();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      if (reads === 1) return { Rules: [] };
      if (reads === 2) return { Rules: [foreign] };
      return { Rules: written[written.length - 1] };
    });
    s3Mock
      .on(PutBucketLifecycleConfigurationCommand)
      .callsFake((input: PutBucketLifecycleConfigurationCommandInput) => {
        written.push(input.LifecycleConfiguration?.Rules ?? []);
        return {};
      });
    await ensureLifecycleRule(client(), target, logger, instant);
    expect(written).toHaveLength(2);
    expect(written[1].map((rule) => rule.ID)).toEqual(
      expect.arrayContaining([
        'someone-else',
        'langgraph-ttl-langgraph-checkpoints-store',
        'langgraph-ttl-langgraph-checkpoints-store-markers',
      ]),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('shows a different configuration without these rules'),
      { attempt: 1, waitedMs: 1000 },
    );
  });

  it('raises CONTENTION when a competing writer replaces the configuration every time', async () => {
    let reads = 0;
    // Each read shows a *different* foreign configuration — never this
    // call's rules, and never the same as the read before its last write —
    // so every round is a competing writer, never mere lag.
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      return { Rules: [{ ...foreign, ID: `someone-else-${reads}` }] };
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const raised = await ensureLifecycleRule(client(), target, SILENT_LOGGER, instant).catch(
      (error: unknown) => error,
    );
    expect(raised).toMatchObject({ code: ErrorCode.CONTENTION });
    // No `operation` of its own: the public boundary stamps the adapter
    // method that reached this call (e.g. `saver.ensureS3LifecycleRule`),
    // which this internal call has none of.
    expect((raised as { context: object }).context).not.toHaveProperty('operation');
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(
      LIFECYCLE_SETTLE_WRITES,
    );
    // The versioning report still runs before the throw, not instead of it.
    expect(s3Mock.commandCalls(GetBucketVersioningCommand)).toHaveLength(1);
  });

  it('waits longer before each rewrite', async () => {
    const waits: number[] = [];
    let reads = 0;
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      return { Rules: [{ ...foreign, ID: `someone-else-${reads}` }] };
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await expect(
      ensureLifecycleRule(client(), target, SILENT_LOGGER, {
        wait: (delayMs) => {
          waits.push(delayMs);
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTENTION });
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it('a non-transient SDK failure still surfaces at once, not retried as contention', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(ensureLifecycleRule(client(), target, SILENT_LOGGER, instant)).rejects.toThrow(
      'denied',
    );
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  /** The same, but from inside the poll rather than the very first read. */
  it('a failure from a later re-read surfaces at once, not swallowed by the poll', async () => {
    let reads = 0;
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      if (reads === 1) return { Rules: [] };
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await expect(ensureLifecycleRule(client(), target, SILENT_LOGGER, instant)).rejects.toThrow(
      'denied',
    );
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  /** Likewise for a rewrite — a Put after the first — rather than the first write. */
  it('a failure from a later rewrite surfaces at once, not swallowed by the poll', async () => {
    let reads = 0;
    let puts = 0;
    s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
      reads += 1;
      return { Rules: [{ ...foreign, ID: `someone-else-${reads}` }] };
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).callsFake(() => {
      puts += 1;
      if (puts === 1) return {};
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    await expect(ensureLifecycleRule(client(), target, SILENT_LOGGER, instant)).rejects.toThrow(
      'denied',
    );
    expect(puts).toBe(2);
  });

  /**
   * No `pace` at all is the shape every real caller uses, so the default
   * `wait` — the real `sleep` — has to be exercised too, not only the
   * injectable one every other case here passes. Fake timers stand in for the
   * real 1 s clock so this stays as fast as the rest of the suite.
   */
  it('really sleeps between re-reads when no pace is given', async () => {
    jest.useFakeTimers();
    try {
      const writes = lifecycleBucket(s3Mock);
      const settled = ensureLifecycleRule(client(), target, SILENT_LOGGER);
      await jest.advanceTimersByTimeAsync(1000);
      await settled;
      expect(writes).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fastLifecyclePoll', () => {
  /**
   * A rejection from the wrapped call sits unconsumed while the clock is
   * being advanced — nothing has looked at it yet at that point — so without
   * marking it handled at once, Jest 30 charges the test with an unhandled
   * rejection even though this very assertion goes on to catch it.
   */
  it('propagates a rejection from the wrapped call, without an unhandled rejection', async () => {
    await expect(fastLifecyclePoll(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });
});
