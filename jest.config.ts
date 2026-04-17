export default {
    testMatch: ['**/*.test.ts'],
    // Integration tests talk to real DynamoDB Local and have their own runner
    // (see jest.integration.config.ts). Excluded here so `npm test` stays fast
    // and deterministic without requiring docker.
    testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
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
            branches: 80,
            functions: 80,
            statements: 80,
        },
    },
    reporters: ['default', ['jest-sonar', {
        outputDirectory: 'coverage',
        outputName: 'test-report.xml',
        reportedFilePath: 'relative'
    }]],
};