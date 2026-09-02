import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
  type SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { guardPublic } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { lifecycleExpirationDays } from '../shared/validation/ttl';
import { getItem } from './actions/get';
import { listNamespaces } from './actions/list-namespaces';
import { putItem } from './actions/put';
import {
  reconcileVectorIndex as reconcileVectorIndexAction,
  type VectorReconcileResult,
} from './actions/reconcile-vector-index';
import { searchItems } from './actions/search';
import { runBatch } from './internal/batch-plan';
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

  /**
   * Execute a batch of operations and return their results in operation
   * order. Writes to one item stay ordered; writes to different items, and
   * then all reads, run concurrently — so a get after a put to the same key
   * in one batch observes the put, and a batch of ten gets costs about one
   * round trip rather than ten (see `runBatch`). The library's error boundary
   * for every `BaseStore` method (`get`/`put`/`delete`/`search`/
   * `listNamespaces` all funnel through here): a raw AWS SDK error surfaces
   * as an `UpstreamError`, and one failing operation rejects the whole batch.
   * @throws ValidationError for a malformed namespace, key or value; UpstreamError; RetryExhaustedError; ResultTruncatedError from a listing over its cap.
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    return guardPublic('store.batch', async () => {
      const results = await runBatch(operations, (operation) => this.dispatch(operation));
      return results as OperationResults<Op>;
    });
  }

  /**
   * Search with optional cancellation. Overrides the base implementation, which
   * routes through {@link batch} and therefore cannot carry a signal. A plain
   * search stops reading once `offset + limit` matches are in hand; a `query`
   * ranks in-process (up to `maxSearchCandidates`) or through the `vectorBackend`.
   * @throws ValidationError when the candidate set exceeds `maxSearchCandidates`; AbortError; UpstreamError.
   */
  override async search(
    namespacePrefix: string[],
    options: Pick<SearchOperation, 'filter' | 'limit' | 'offset' | 'query'> & CancelOptions = {},
  ): Promise<SearchItem[]> {
    const { signal, ...rest } = options;
    return guardPublic('store.search', () =>
      searchItems(this.context, { namespacePrefix, ...rest }, signal),
    );
  }

  /**
   * Repair the configured vector backend against the canonical items under
   * `namespacePrefix`. A maintenance tool; see {@link reconcileVectorIndex}.
   * @throws ValidationError without an `index` and `vectorBackend` or for an empty prefix; ResultTruncatedError past `maxScanItems`.
   */
  reconcileVectorIndex(
    namespacePrefix: string[],
    options?: CancelOptions,
  ): Promise<VectorReconcileResult> {
    return guardPublic('store.reconcileVectorIndex', () =>
      reconcileVectorIndexAction(this.context, namespacePrefix, options),
    );
  }

  /**
   * LangGraph's lifecycle hook. A host that manages stores through the
   * upstream `BaseStore` interface calls `stop()`, so it releases the owned
   * client exactly like {@link destroy}, which stays the explicit API. Both
   * are idempotent.
   */
  override stop(): void {
    this.destroy();
  }

  /** Release owned resources (the underlying client and any S3 client). */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }

  /**
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded objects don't outlive their DynamoDB item forever. No-ops when
   * S3 offload or TTL isn't configured; throws when the bucket cannot be read
   * or written. Requires the `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` bucket-level permissions (broader than the
   * object-level CRUD the rest of S3 offload needs) — call this once during
   * deployment/provisioning, not per-request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('store.ensureS3LifecycleRule', async () => {
      if (!this.context.offloader || !this.context.ttl) return;
      await this.context.offloader.ensureLifecycleRule(lifecycleExpirationDays(this.context.ttl));
    });
  }
}
