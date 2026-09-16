import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
} from '@langchain/langgraph-checkpoint';

import { guardPublic } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { assertSignalLike } from '../shared/validation/collaborators';
import { assertCancelOptions, STORE_SEARCH_KEYS } from '../shared/validation/method-keys';
import { assertShape } from '../shared/validation/option-shape';
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
import type { DynamoDBStoreOptions, SearchOptions } from './types';

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

  /**
   * Accepts: `options` — validated here, so a misconfiguration surfaces at
   * construction rather than on the first request. A `vectorBackend` without an
   * `index` is refused outright, since every put would then clear the item's
   * vector and every query would answer unranked.
   *
   * Returns: a store that owns the client it built, or borrows the one it was
   * given.
   *
   * Throws: ValidationError naming the offending option.
   *
   * Guarantees: no I/O. Constructing a store issues no request.
   */
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
   * order.
   *
   * Accepts: `operations` — in the order they are to be observed; an empty
   * batch does nothing. Every `BaseStore` method (`get`/`put`/`delete`/
   * `search`/`listNamespaces`) funnels through here, so this is the library's
   * error boundary for all of them.
   *
   * Returns: the results in operation order — an item or `null` for a get,
   * matches for a search, namespaces for a listing, nothing for a put.
   *
   * Throws: ValidationError for a malformed namespace, key or value;
   * UpstreamError; RetryExhaustedError; ResultTruncatedError from a listing
   * over its cap. One failing operation rejects the whole batch.
   *
   * Guarantees: the order the caller wrote is the order the caller observes — a
   * get after a put of the same item sees it, a get before one does not, and a
   * search sees every write that precedes it and none that follow. Operations
   * addressing different items run concurrently, so a batch of ten gets costs
   * about one round trip rather than ten (see `runBatch`).
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    return guardPublic('store.batch', async () => {
      const results = await runBatch(
        operations,
        (operation) => this.dispatch(operation),
        this.context.readConcurrency,
      );
      return results as OperationResults<Op>;
    });
  }

  /**
   * Search with optional cancellation. Overrides the base implementation, which
   * routes through {@link batch} and therefore cannot carry a signal.
   *
   * Accepts: `namespacePrefix` — empty spans the whole table. `options.query` —
   * absent or empty ranks nothing. `options.filter` — metadata equality on the
   * item's value. `options.offset`/`limit` — non-negative integers, defaulting
   * to 0 and 10. `options.signal` — aborts the reads.
   *
   * Returns: at most `limit` items from `offset`, each carrying a `score` when
   * a query and an index are configured.
   *
   * Throws: ValidationError naming `offset`, `limit`, `maxSearchCandidates`,
   * `index.dims`, `signal`, or `options.<key>` for a key this package does not
   * read; AbortError; UpstreamError.
   *
   * Guarantees: a plain search stops reading once `offset + limit` matches are
   * in hand; a query ranks in-process up to `maxSearchCandidates`, or through
   * the `vectorBackend` when one is configured.
   */
  override async search(
    namespacePrefix: string[],
    options: SearchOptions = {},
  ): Promise<SearchItem[]> {
    return guardPublic('store.search', () => {
      assertShape(options, STORE_SEARCH_KEYS, 'options');
      assertSignalLike(options.signal);
      const { signal, ...rest } = options;
      return searchItems(this.context, { namespacePrefix, ...rest }, signal);
    });
  }

  /**
   * Repair the configured vector backend against the canonical items under
   * `namespacePrefix`. A maintenance tool; see the action of the same name.
   *
   * Accepts: `namespacePrefix` — a non-empty namespace. `options.signal` —
   * aborts between pages.
   *
   * Returns: how many vectors were upserted and how many pruned.
   *
   * Throws: ValidationError without both an `index` and a `vectorBackend`, for
   * an empty prefix, for an invalid `signal`, or for `options.<key>` naming a
   * key this package does not read; ResultTruncatedError past `maxScanItems`;
   * UpstreamError.
   *
   * Guarantees: DynamoDB is never written — only the backend is repaired — and
   * a vector is deleted only on evidence that its item is gone.
   */
  reconcileVectorIndex(
    namespacePrefix: string[],
    options?: CancelOptions,
  ): Promise<VectorReconcileResult> {
    return guardPublic('store.reconcileVectorIndex', () => {
      assertCancelOptions(options);
      return reconcileVectorIndexAction(this.context, namespacePrefix, options);
    });
  }

  /**
   * LangGraph's lifecycle hook.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. A host that manages stores through the upstream
   * `BaseStore` interface calls `stop()`, so it releases the owned client
   * exactly like {@link destroy}, which stays the explicit API. Both are
   * idempotent.
   *
   * Throws: nothing this adapter raises.
   */
  override stop(): void {
    this.destroy();
  }

  /**
   * Release owned resources.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Idempotent, and a no-op for a client the caller injected
   * — that one is theirs to close.
   *
   * Throws: nothing this adapter raises.
   */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }

  /**
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded objects don't outlive their DynamoDB item forever.
   *
   * Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
   * without both.
   *
   * Returns: nothing. Installing a rule that is already there is a no-op too,
   * so calling it on every deploy is safe.
   *
   * Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
   * UpstreamError when the bucket's lifecycle cannot be read or written.
   * @remarks Requires the bucket-level `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` permissions, broader than the object-level
   * CRUD the rest of S3 offload needs — call it once during provisioning, not
   * per request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('store.ensureS3LifecycleRule', async () => {
      if (!this.context.offloader || !this.context.ttl) return;
      await this.context.offloader.ensureLifecycleRule(lifecycleExpirationDays(this.context.ttl));
    });
  }
}
