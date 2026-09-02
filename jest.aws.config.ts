import { sharedJestConfig } from './jest.shared.config.ts';

/**
 * Real-AWS tier: creates and deletes uniquely named tables and buckets
 * (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential
 * chain. Runs nightly in CI and on demand:
 *
 *   AWS_REGION=eu-central-1 npm run test:aws
 */
export default {
  ...sharedJestConfig,
  testMatch: ['<rootDir>/test/aws/**/*.test.ts'],
  testTimeout: 120000,
  collectCoverage: false,
  maxWorkers: 1,
};
