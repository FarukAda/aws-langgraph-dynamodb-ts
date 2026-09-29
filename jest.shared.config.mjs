/**
 * The transform and environment every jest tier shares. The tiers differ only
 * in what they match, their timeouts and whether they collect coverage.
 */
export const sharedJestConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The sources import each other by their emitted `.js` names, which name no
  // file before a build: jest resolves the `.ts` source behind each one.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
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
};
