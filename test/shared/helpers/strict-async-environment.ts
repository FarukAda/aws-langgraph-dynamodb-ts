import { TestEnvironment } from 'jest-environment-node';

/**
 * The Node test environment, plus: a test fails when Node emits a
 * `MaxListenersExceededWarning` or a `DeprecationWarning` while it runs.
 *
 * A `MaxListenersExceededWarning` means a listener is added per call and never
 * removed, the leak `raceAbort` is written to avoid; a `DeprecationWarning`
 * means an API this code calls is on its way out. Node only prints either one,
 * so without this the suite stays green through both.
 *
 * The listener has to live here, not in a setup file. A test file runs in a
 * sandbox whose `process` is a copy, so a listener registered there never
 * hears the warnings Node emits on the real `process`; the environment runs
 * outside the sandbox and does.
 *
 * Unhandled rejections are not trapped here: jest already fails the test that
 * leaves one, which `test/unit/shared/strict-async-environment.test.ts` checks.
 */
const TRAPPED_WARNINGS = new Set(['MaxListenersExceededWarning', 'DeprecationWarning']);

/** The one part of jest-circus's test events this environment reads. */
interface TestEvent {
  name: string;
  test?: { errors: unknown[] };
}

export default class StrictAsyncEnvironment extends TestEnvironment {
  private readonly warnings: string[] = [];

  private readonly onWarning = (warning: Error): void => {
    if (TRAPPED_WARNINGS.has(warning.name))
      this.warnings.push(`${warning.name}: ${warning.message}`);
  };

  override async setup(): Promise<void> {
    await super.setup();
    process.on('warning', this.onWarning);
  }

  /**
   * Charges every warning trapped since the previous test finished to the test
   * finishing now, so one a `beforeAll` causes lands on the first test after
   * it. Node emits a warning on a later tick than the call that caused it, so
   * the check waits one turn of the event loop first.
   */
  async handleTestEvent(event: TestEvent): Promise<void> {
    if (event.name !== 'test_done' || event.test === undefined) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (this.warnings.length === 0) return;
    const reported = this.warnings.splice(0).join('\n');
    event.test.errors.push(new Error(`Node warning during this test:\n${reported}`));
  }

  /** A warning emitted outside any test fails the file rather than vanishing. */
  override async teardown(): Promise<void> {
    process.off('warning', this.onWarning);
    await super.teardown();
    if (this.warnings.length > 0) {
      throw new Error(`Node warning outside a test:\n${this.warnings.splice(0).join('\n')}`);
    }
  }
}
