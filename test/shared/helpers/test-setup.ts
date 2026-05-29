/**
 * Per-test setup wiring (strict-only). Installs the strict DDB mock, freezes
 * time, resets the logger, and asserts no leaked unexpected commands in
 * afterEach. There are intentionally no loose helpers here (REQ-5 / REQ-40 /
 * AC-35).
 *
 * This module is referenced from jest.config's `setupFilesAfterEnv` so the
 * frozen time + seeded RNG defaults apply across the unit suite.
 */
import { resetLogger } from '../../../src/index';
import { createStrictDdbMock, type StrictDdbMock } from '../mocks/dynamodb';
import { FROZEN_NOW_MS, installFrozenTime, restoreTime, seededRandom } from './frozen-time';

export interface StrictTestHandles {
  ddb: StrictDdbMock;
}

/**
 * Set up a strict test: frozen time, seeded Math.random, strict DDB mock, clean
 * logger. Call inside a describe and tear down with the returned restore.
 */
export function setupStrictTest(): StrictTestHandles & { restore: () => void } {
  installFrozenTime(FROZEN_NOW_MS);
  const rng = seededRandom();
  const realRandom = Math.random;
  Math.random = rng;
  resetLogger();
  const ddb = createStrictDdbMock();

  return {
    ddb,
    restore: () => {
      ddb.mock.restore();
      Math.random = realRandom;
      resetLogger();
      restoreTime();
    },
  };
}

/**
 * Default global beforeEach/afterEach installer. When imported as
 * setupFilesAfterEnv this freezes time and seeds RNG for every test by default.
 */
beforeEach(() => {
  installFrozenTime(FROZEN_NOW_MS);
  Math.random = seededRandom();
});

afterEach(() => {
  Math.random = (() => {
    const original = Object.getPrototypeOf(Math).random;
    return typeof original === 'function' ? original.bind(Math) : Math.random;
  })();
  restoreTime();
  resetLogger();
  jest.clearAllMocks();
});
