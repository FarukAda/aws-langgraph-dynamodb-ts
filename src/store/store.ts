import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
} from '@langchain/langgraph-checkpoint';

import { getItem } from './actions/get';
import { listNamespaces } from './actions/list-namespaces';
import { putItem } from './actions/put';
import { searchItems } from './actions/search';
import { type StoreContext, setUpStore } from './internal/setup';
import type { DynamoDBStoreOptions } from './types';

type SingleResult = Item | null | SearchItem[] | string[][] | void;

/**
 * DynamoDB-backed LangGraph store for long-term memory with optional semantic
 * search. A thin orchestrator: the base class's get/put/search/delete/
 * listNamespaces all funnel into {@link batch}, which dispatches each operation.
 */
export class DynamoDBStore extends BaseStore {
  private readonly context: StoreContext;
  private readonly ownsClient: boolean;
  private readonly ddbClient: ReturnType<typeof setUpStore>['ddbClient'];

  constructor(options: DynamoDBStoreOptions) {
    super();
    const setup = setUpStore(options);
    this.context = setup.context;
    this.ownsClient = setup.ownsClient;
    this.ddbClient = setup.ddbClient;
  }

  private dispatch(operation: Operation): Promise<SingleResult> {
    if ('namespacePrefix' in operation) return searchItems(this.context, operation);
    if ('value' in operation) return putItem(this.context, operation);
    if ('key' in operation) return getItem(this.context, operation.namespace, operation.key);
    return listNamespaces(this.context, operation);
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: SingleResult[] = [];
    for (const operation of operations) {
      results.push(await this.dispatch(operation));
    }
    return results as OperationResults<Op>;
  }

  /** Release owned resources (the underlying client and any S3 client). */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }
}
