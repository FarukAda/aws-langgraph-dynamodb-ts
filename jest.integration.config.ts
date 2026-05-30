/**
 * Integration test runner. These tests talk to a real DynamoDB Local instance
 * on `http://localhost:8000` (see docker-compose.yml) and are intentionally
 * kept out of the default `npm test` run:
 *
 *   docker compose up -d
 *   npm run test:integration
 *   docker compose down
 *
 * Differences from the unit config:
 *   - testMatch targets `test/integration/**`
 *   - no coverage collection (unit tests own coverage enforcement)
 *   - higher timeout: DDB Local cold-starts and table creates aren't free
 *   - runInBand: all tests share a single DDB instance and create/teardown
 *     tables per-file, so parallelism would cause table-name collisions
 */
export default {
  testMatch: [
    '<rootDir>/test/integration/**/*.test.ts',
    '<rootDir>/test/contract/**/*.test.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          rootDir: '.',
        },
      },
    ],
  },
  verbose: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 120000,
  clearMocks: true,
  collectCoverage: false,
  maxWorkers: 1,
};
