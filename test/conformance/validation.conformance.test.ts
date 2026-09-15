import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { validate } from '@langchain/langgraph-checkpoint-validation';

import { DynamoDBSaver } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../integration/helpers/ddb-local';

/**
 * LangChain's own checkpointer validation suite (put, putWrites, getTuple,
 * list, deleteThread) against DynamoDB Local. Each validation set gets a fresh
 * table so no state leaks between sets.
 */
/**
 * The suite also targets Vitest and calls `expect.soft` in one test; Jest has
 * no soft assertions, so a hard one stands in for it.
 */
const jestExpect = expect as typeof expect & { soft?: typeof expect };
jestExpect.soft ??= expect;

/**
 * The one test the suite exempts, by name, for every saver that stores whole
 * checkpoints instead of channel deltas.
 *
 * `it_skipForSomeModules` (the suite's `dist/test_utils.js:11`) turns this test
 * off for `MemorySaver` and for the first-party MongoDB and SQLite savers, each
 * with the note "TODO: … doesn't store channel deltas". `MemorySaver.put`
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:206`) takes three
 * parameters — it never sees `newVersions` — and stores the whole checkpoint,
 * so the reference implementation does not meet this expectation either.
 *
 * `DynamoDBSaver` behaves the same way, for a stronger reason: narrowing by
 * `newVersions` stored *nothing* when LangGraph forks a checkpoint or writes an
 * empty update, both of which pass an empty `newVersions`, so a put silently
 * dropped the caller's state (see `putCheckpoint`). The exemption is keyed on a
 * hard-coded list of module names rather than on the behaviour, which is why it
 * has to be applied here.
 */
const CHANNEL_DELTA_TEST =
  'should only store channel_values that have changed (based on newVersions)';
const SKIP_REASON =
  "DynamoDBSaver doesn't store channel deltas: narrowing by newVersions dropped state on a fork";

/**
 * Register the suite with that one test skipped, in the same shape and with the
 * same `[because …]` title the suite's own exemption produces. The suite calls
 * the global `it`, so shimming it for the duration of registration reaches
 * exactly the tests it declares and nothing else.
 */
function registerWithExemption(register: () => void): void {
  const original = globalThis.it;
  const shim = ((name: string, fn?: never, timeout?: number) =>
    name === CHANNEL_DELTA_TEST
      ? original.skip(`[because ${SKIP_REASON}] ${name}`, fn, timeout)
      : original(name, fn, timeout)) as unknown as typeof globalThis.it;
  Object.assign(shim, original);
  globalThis.it = shim;
  try {
    register();
  } finally {
    globalThis.it = original;
  }
}

const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const tables = new Map<DynamoDBSaver, string>();
let created = 0;

registerWithExemption(() =>
  validate({
    checkpointerName: 'DynamoDBSaver',
    beforeAllTimeout: 60_000,
    async createCheckpointer() {
      created += 1;
      const tableName = `checkpoints-validation-${created}`;
      await createTable(admin, tableName);
      const saver = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG });
      tables.set(saver, tableName);
      return saver;
    },
    async destroyCheckpointer(saver) {
      saver.destroy();
      const tableName = tables.get(saver);
      tables.delete(saver);
      if (tableName !== undefined) await deleteTable(admin, tableName);
    },
    afterAll() {
      admin.destroy();
    },
  }),
);
