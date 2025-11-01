/**
 * Assertion helpers for common test patterns
 * Reduce verbosity and improve test readability
 */

import type { AwsStub } from 'aws-sdk-client-mock';

/**
 * Assert that DynamoDB was called a specific number of times
 *
 * @param mock - DynamoDB mock instance
 * @param expectedCalls - Expected number of calls
 */
export function expectDynamoDBCalled(mock: AwsStub<any, any, any>, expectedCalls: number): void {
  expect(mock.calls()).toHaveLength(expectedCalls);
}

/**
 * Assert that serde was called a specific number of times
 *
 * @param serde - Serde mock instance
 * @param expectedCalls - Expected number of calls
 */
export function expectSerdeCalledTimes(serde: any, expectedCalls: number): void {
  expect(serde.dumpsTyped).toHaveBeenCalledTimes(expectedCalls);
}

/**
 * Assert that a promise rejects with a specific validation error
 *
 * @param promise - Promise that should reject
 * @param expectedMessage - Expected error message (partial match)
 */
export async function expectValidationError(
  promise: Promise<any>,
  expectedMessage: string,
): Promise<void> {
  await expect(promise).rejects.toThrow(expectedMessage);
}
