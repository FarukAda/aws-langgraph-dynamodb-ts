import { sharedJestConfig } from './jest.shared.config.mjs';

/**
 * Real-AWS tier: creates and deletes uniquely named tables and buckets
 * (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential
 * chain, in the region `AWS_REGION` names; a run without one refuses to start.
 *
 * It runs on every release tag, in `.github/workflows/integration-live.yml`,
 * assuming the role the repository variable or secret `AWS_TEST_ROLE_ARN`
 * names in the region `AWS_TEST_REGION` names, and gates publishing: the release waits for its `live-aws integration`
 * check (docs/decisions, record 18). A maintainer can also run it locally
 * with their own credentials:
 *
 *   AWS_REGION=eu-central-1 npm run test:aws
 *
 * Deliberately not on a schedule. One suite calls Bedrock, so a scheduled job
 * that retried or looped would bill the account with nobody watching, and the
 * answer the tier gives only matters when a version is about to be published.
 */
export default {
  ...sharedJestConfig,
  testMatch: ['<rootDir>/test/aws/**/*.test.ts'],
  testTimeout: 120000,
  collectCoverage: false,
  maxWorkers: 1,
};
