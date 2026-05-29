export default {
    testMatch: ['**/*.test.ts'],
    // Integration tests talk to real DynamoDB Local and have their own runner
    // (see jest.integration.config.ts). Excluded here so `npm test` stays fast
    // and deterministic without requiring docker.
    testPathIgnorePatterns: ['/node_modules/', '/test/integration/', '/test/package-smoke/'],
    // Strict determinism defaults (spec §5.L): freeze Date.now() to
    // FROZEN_NOW_MS and seed Math.random() before every test. Without this the
    // real wall clock leaks into TTL/timestamp assertions.
    setupFilesAfterEnv: ['<rootDir>/test/shared/helpers/test-setup.ts'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                rootDir: '.',
            }
        }]
    },
    verbose: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
    testTimeout: 90000,
    clearMocks: true,
    collectCoverage: true,
    collectCoverageFrom: [
        '<rootDir>/src/**/*.ts',
        '!<rootDir>/src/**/*.d.ts',
    ],
    coverageDirectory: "coverage",
    coverageThreshold: {
        global: {
            branches: 90,
            functions: 95,
            lines: 95,
            statements: 95,
        },
    },
    reporters: ['default', ['jest-sonar', {
        outputDirectory: 'coverage',
        outputName: 'test-report.xml',
        reportedFilePath: 'relative'
    }]],
};