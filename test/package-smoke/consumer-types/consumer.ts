/**
 * A consumer that injects its own DocumentClient, exactly as the README's
 * "bring your own client" path describes.
 *
 * The package.json beside this file pins an older `@aws-sdk/lib-dynamodb` than
 * this package depends on, so npm installs a second, newer copy nested under
 * the package and the `DynamoDBDocument` built here is a different nominal type
 * from the one the shipped declarations name. Every construction below is the
 * assertion: if the `client` option is typed against the nested copy, each one
 * fails with TS2741 naming a member only the newer copy has.
 *
 * Nothing here runs — the check is `tsc --noEmit`, and runtime injection was
 * never the broken half.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import {
  backfillRecencyIndex,
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBSaver,
  DynamoDBStore,
  type BackfillResult,
} from '@farukada/aws-langgraph-dynamodb-ts';

/** The consumer's own client, from the consumer's own copy of the SDK. */
const client = DynamoDBDocument.from(new DynamoDBClient({ region: 'eu-west-1' }));

export const saver = new DynamoDBSaver({ tableName: 'app', client });

export const store = new DynamoDBStore({ tableName: 'app', client });

export const history = new DynamoDBChatMessageHistory({ tableName: 'app', client });

export const factory = new DynamoDBFactory({ client });

export function backfill(): Promise<BackfillResult> {
  return backfillRecencyIndex({ tableName: 'app', client, dryRun: true });
}
