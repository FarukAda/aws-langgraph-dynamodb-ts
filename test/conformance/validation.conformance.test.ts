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

const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const tables = new Map<DynamoDBSaver, string>();
let created = 0;

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
});
