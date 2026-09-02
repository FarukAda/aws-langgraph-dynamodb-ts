import { sharedJestConfig } from './jest.shared.config.ts';

/**
 * Integration and contract tiers against DynamoDB Local (docker-compose.yml):
 *
 *   docker compose up -d && npm run test:integration && docker compose down
 *
 * No coverage (the unit tier owns it), a longer timeout for table creates, and
 * one worker because every file creates and tears down its own tables.
 */
export default {
  ...sharedJestConfig,
  testMatch: ['<rootDir>/test/integration/**/*.test.ts', '<rootDir>/test/contract/**/*.test.ts'],
  testTimeout: 120000,
  collectCoverage: false,
  maxWorkers: 1,
};
