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
import { lifecycleBucket } from '../../../../shared/helpers/lifecycle-bucket';

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

describe('ensureLifecycleRule reads back what it wrote', () => {
  it('writes once, and stops when the re-read shows its rules', async () => {
    const writes = lifecycleBucket(s3Mock);
    await ensureLifecycleRule(client(), target, SILENT_LOGGER, instant);
    expect(writes).toHaveLength(1);
    expect(s3Mock.commandCalls(GetBucketLifecycleConfigurationCommand)).toHaveLength(2);
  });

  it("writes its rules again, beside the other writer's, when a concurrent write replaced them", async () => {
    let reads = 0;
    const written: LifecycleRule[][] = [];
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
    await ensureLifecycleRule(client(), target, SILENT_LOGGER, instant);
    expect(written).toHaveLength(2);
    expect(written[1].map((rule) => rule.ID)).toEqual(
      expect.arrayContaining([
        'someone-else',
        'langgraph-ttl-langgraph-checkpoints-store',
        'langgraph-ttl-langgraph-checkpoints-store-markers',
      ]),
    );
  });

  it('raises CONTENTION when its rules never stay', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [foreign] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await expect(
      ensureLifecycleRule(client(), target, SILENT_LOGGER, instant),
    ).rejects.toMatchObject({ code: ErrorCode.CONTENTION });
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(
      LIFECYCLE_SETTLE_WRITES,
    );
  });

  it('waits longer before each rewrite', async () => {
    const waits: number[] = [];
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
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

  /**
   * No `pace` at all is the shape every real caller uses, so the default
   * `wait` — the real `sleep` — has to be exercised too, not only the
   * injectable one every other case here passes. Fake timers stand in for the
   * real 1 s clock so this stays as fast as the rest of the suite.
   */
  it('really sleeps between writes when no pace is given', async () => {
    jest.useFakeTimers();
    try {
      let reads = 0;
      const written: LifecycleRule[][] = [];
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
      const settled = ensureLifecycleRule(client(), target, SILENT_LOGGER);
      await jest.advanceTimersByTimeAsync(1000);
      await settled;
      expect(written).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
