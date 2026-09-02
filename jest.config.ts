import { sharedJestConfig } from './jest.shared.config.ts';

/**
 * Unit tier: unit tests, static guards, type locks and property tests.
 * Coverage (100 % on every metric) is collected when jest runs with
 * `--coverage`, which `npm test` passes; a single-file run stays fast.
 */
export default {
  ...sharedJestConfig,
  testMatch: [
    '<rootDir>/test/unit/**/*.test.ts',
    '<rootDir>/test/static/**/*.test.ts',
    '<rootDir>/test/types/**/*.test.ts',
    '<rootDir>/test/property/**/*.test.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/test/integration/',
    '/test/contract/',
    '/test/package-smoke/',
  ],
  setupFilesAfterEnv: ['<rootDir>/test/shared/helpers/test-setup.ts'],
  testTimeout: 15000,
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
