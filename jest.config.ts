export default {
  testMatch: [
    '<rootDir>/test/unit/**/*.test.ts',
    '<rootDir>/test/static/**/*.test.ts',
    '<rootDir>/test/types/**/*.test.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/test/integration/',
    '/test/contract/',
    '/test/package-smoke/',
  ],
  setupFilesAfterEnv: ['<rootDir>/test/shared/helpers/test-setup.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          rootDir: '.',
          module: 'commonjs',
        },
      },
    ],
  },
  verbose: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 90000,
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
  reporters: [
    'default',
    [
      'jest-sonar',
      { outputDirectory: 'coverage', outputName: 'test-report.xml', reportedFilePath: 'relative' },
    ],
  ],
};