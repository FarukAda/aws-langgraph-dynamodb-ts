import type { LifecycleRule, S3Client } from '@aws-sdk/client-s3';

import { loadS3Sdk } from './client';
import { buildLifecycleRuleId } from './config';

async function readRules(client: S3Client, bucket: string): Promise<LifecycleRule[]> {
  const { GetBucketLifecycleConfigurationCommand } = await loadS3Sdk();
  try {
    const existing = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    return existing.Rules ?? [];
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchLifecycleConfiguration') return [];
    throw error;
  }
}

function alreadyCorrect(rule: LifecycleRule | undefined, ttlDays: number): boolean {
  return rule?.Status === 'Enabled' && rule.Expiration?.Days === ttlDays;
}

/**
 * Idempotently ensure a `${ttlDays}`-day expiration lifecycle rule exists for
 * `prefix`. Reads existing rules, preserves user-defined ones, and only
 * adds/updates the library's prefix-scoped rule.
 */
export async function ensureLifecycleRule(
  client: S3Client,
  bucket: string,
  prefix: string,
  ttlDays: number,
): Promise<void> {
  const ruleId = buildLifecycleRuleId(prefix);
  const rules = await readRules(client, bucket);
  const existing = rules.find((rule) => rule.ID === ruleId);
  if (alreadyCorrect(existing, ttlDays)) return;
  const newRule: LifecycleRule = {
    ID: ruleId,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { Days: ttlDays },
  };
  const merged = existing
    ? rules.map((rule) => (rule.ID === ruleId ? newRule : rule))
    : [...rules, newRule];
  const { PutBucketLifecycleConfigurationCommand } = await loadS3Sdk();
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: merged },
    }),
  );
}
