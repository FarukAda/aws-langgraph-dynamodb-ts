/**
 * The transform and environment every jest tier shares. The tiers differ only
 * in what they match, their timeouts and whether they collect coverage.
 */
export const sharedJestConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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
  clearMocks: true,
} as const;
