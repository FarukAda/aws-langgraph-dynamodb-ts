import { sharedJestConfig } from './jest.shared.config.ts';

/**
 * Conformance tier against DynamoDB Local: a compiled LangGraph graph over the
 * saver and LangChain's checkpointer validation suite.
 *
 *   docker compose up -d && npm run test:conformance && docker compose down
 */
export default {
  ...sharedJestConfig,
  testMatch: ['<rootDir>/test/conformance/**/*.test.ts'],
  testTimeout: 120000,
  collectCoverage: false,
  maxWorkers: 1,
};
