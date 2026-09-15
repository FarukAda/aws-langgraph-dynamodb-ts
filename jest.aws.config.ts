import { sharedJestConfig } from './jest.shared.config.ts';

/**
 * Real-AWS tier: creates and deletes uniquely named tables and buckets
 * (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential
 * chain. Run by a maintainer on demand, before a release:
 *
 *   AWS_REGION=eu-central-1 npm run test:aws
 *
 * Deliberately not on a schedule. One suite calls Bedrock, so a scheduled job
 * that retried or looped would bill the account with nobody watching — a cost
 * nobody would notice until the invoice. Running it by hand keeps the spend
 * attached to a person who chose to spend it.
 */
export default {
  ...sharedJestConfig,
  testMatch: ['<rootDir>/test/aws/**/*.test.ts'],
  testTimeout: 120000,
  collectCoverage: false,
  maxWorkers: 1,
};
