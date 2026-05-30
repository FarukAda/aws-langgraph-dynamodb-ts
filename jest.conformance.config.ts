/**
 * Conformance test runner. Drives the public adapters against a real DynamoDB
 * Local instance (see docker-compose.yml) to validate LangGraph contract
 * behaviors that unit mocks cannot prove — notably the WRITES_IDX_MAP
 * special-write dedup/ordering contract.
 *
 *   docker compose up -d
 *   npm run test:conformance
 *   docker compose down
 */
export default {
  testMatch: ['<rootDir>/test/conformance/**/*.test.ts'],
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
