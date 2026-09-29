import { sharedJestConfig } from './jest.shared.config.mjs';

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
  testEnvironment: '<rootDir>/test/shared/helpers/strict-async-environment.ts',
  setupFilesAfterEnv: ['<rootDir>/test/shared/helpers/test-setup.ts'],
  testTimeout: 15000,
  // A static guard builds a whole TypeScript program in its worker, several
  // hundred MB each. Recycling a worker once its heap passes this limit keeps
  // those programs from piling up in one long-lived process, the load under
  // which V8's GC has crashed workers with SIGSEGV on Node 24 macOS arm64.
  workerIdleMemoryLimit: '512MB',
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
