export default {
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
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