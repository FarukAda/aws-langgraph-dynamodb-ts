/**
 * Real-AWS test runner. These tests create and delete a real DynamoDB table in
 * the account resolved from the default credential chain, so they are isolated
 * from `npm test` and `npm run test:integration` and only run on demand:
 *
 *   npm run test:aws
 *
 * Resources are uniquely named (`aws-langgraph-awstest-<uuid>`) and torn down in
 * afterAll. Set AWS_REGION to target a specific region.
 */
export default {
  testMatch: ['<rootDir>/test/aws/**/*.test.ts'],
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