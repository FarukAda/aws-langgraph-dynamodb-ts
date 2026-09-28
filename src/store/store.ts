/**
 * Hides which public methods share one guarded dispatch, and which do not.
 *
 * `get`, `put`, `delete`, `listNamespaces` and `batch` parse their arguments
 * and hand the parsed operations to the same batch runner and dispatch, so
 * the five answer and refuse alike. `search` guards the same way but calls
 * its own action directly, to carry a signal that `batch` cannot;
 * `reconcileVectorIndex` and `ensureS3LifecycleRule` guard directly too,
 * since neither is a batchable store operation. Each asynchronous method
 * declared here is also the error boundary (record 13); `stop` and `destroy`
 * are the synchronous exceptions, releasing what the store owns through its
 * shell, and the inherited `start()` no-op — declared by `BaseStore`, not
 * overridden here — is neither guarded nor routed through any of this.
 */

import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
} from '@langchain/langgraph-checkpoint';

import type { AdapterShell } from '../shared/adapter';
import { guardPublic } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { assertSignalLike, assertCancelOptions } from '../shared/validation/collaborators';
import { assertShape } from '../shared/validation/option-shape';
import { listNamespaces } from './actions/list-namespaces';
import { putItem } from './actions/put';
import { reconcileVectorIndex as reconcileVectorIndexAction } from './actions/reconcile-vector-index';
import { searchItems } from './actions/search';
import { runBatch } from './internal/batch-plan';
import { getItem } from './internal/get-item';
import {
  parseListNamespacesOptions,
  parseNamespacePrefix,
  parseOperations,
  type ParsedOperation,
  parsePutArguments,
  parseSearch,
  parseStoreAddress,
} from './internal/parse';
import { STORE_SEARCH_KEYS, type StoreContext, setUpStore } from './internal/setup';
import type {
  DynamoDBStoreOptions,
  ListNamespacesOptions,
  SearchOptions,
  VectorReconcileResult,
} from './types';

type SingleResult = Item | null | SearchItem[] | string[][];

/**
 * DynamoDB-backed LangGraph store for long-term memory with optional semantic
 * search. `get`, `put`, `delete` and `listNamespaces` answer and refuse exactly
 * as the same operation inside a {@link batch} does, and `put` keeps upstream's
 * own namespace rules. Every public method rejects only with this library's
 * error.
 */
export class DynamoDBStore extends BaseStore {
  private readonly context: StoreContext;
  private readonly shell: AdapterShell;

  /**
   * Accepts: `options` — validated here, so a misconfiguration surfaces at
   * construction rather than on the first request. A `vectorBackend` without an
   * `index` is refused outright, since every put would then clear the item's
   * vector and every query would answer unranked.
   *
   * Returns: a store that owns the client it built, or borrows the one it was
   * given.
   *
   * Throws: `VALIDATION` naming the offending option.
   *
   * Guarantees: no I/O. Constructing a store issues no request.
   */
  constructor(options: DynamoDBStoreOptions) {
    super();
    const setup = setUpStore(options);
    this.context = setup.context;
    this.shell = setup.shell;
  }

  /**
   * One operation's result: the item for a get, the page for a search, the
   * namespaces for a listing, and `null` for a put or a delete — the value the
   * reference store's `batch` answers a put or a delete with. The kind was
   * decided once, by the parser that built `operation`, so this switches on it
   * instead of asking the operation's shape again.
   */
  private async dispatch(operation: ParsedOperation): Promise<SingleResult> {
    switch (operation.kind) {
      case 'search':
        return searchItems(this.context, operation);
      case 'put':
      case 'delete':
        await putItem(this.context, operation);
        return null;
      case 'get':
        return getItem(this.context, operation.address);
      case 'list':
        return listNamespaces(this.context, operation);
    }
  }

  /**
   * Run a batch of already-parsed operations, with no boundary of its own.
   *
   * The guard is the caller's method, not this: a nested `guardPublic` keeps
   * the brand the *inner* one assigned, so routing `get`, `put`, `delete` and
   * `listNamespaces` through the public {@link batch} reported all four as
   * `store.batch` and left an operator counting AWS failures by
   * `context.operation` unable to tell them apart.
   */
  private async execute(operations: readonly ParsedOperation[]): Promise<SingleResult[]> {
    return runBatch(
      operations,
      (operation) => this.dispatch(operation),
      this.context.readConcurrency,
    );
  }

  /**
   * Execute a batch of operations and return their results in operation
   * order.
   *
   * Accepts: `operations` — an array of operation objects, in the order they
   * are to be observed; an empty batch does nothing and returns `[]`. Every
   * operation is checked before any of them runs. A put carrying a `null`
   * value deletes its item. `get`, `put`, `delete` and `listNamespaces` check
   * their own call by the same rules and run the same dispatch, as upstream's
   * implementations do, so the field a malformed call names is the same
   * whichever of the five reached it — `put` alone adds what is about the
   * method: upstream's own `.` and `"langgraph"` namespace rules, and a refusal
   * of a `null` value, since `delete` is how an item is removed. Each of the
   * four keeps its own name in `context.operation`, so a failure says which
   * method the caller called rather than reporting all five alike.
   *
   * Returns: the results in operation order — an item or `null` for a get,
   * matches for a search, namespaces for a listing, `null` for a put or a
   * delete, as the reference store answers them.
   *
   * Throws: `VALIDATION`, raised for every operation before any operation
   * runs, naming `operations` for a value that is not an array or an entry that
   * is not an object; `namespace`, `namespace element`, `key` or `sortKey` for an
   * item address; `value` or `index` for a put; `namespacePrefix`,
   * `namespacePrefix element`, `filter`, `query`, `offset` or `limit` for a
   * search; `offset`, `limit`, `maxDepth`, `matchConditions`, `prefix`,
   * `prefix element`, `suffix` or `suffix element` for a listing; and later,
   * from a running operation, `value` for one JSON cannot represent,
   * `maxSearchCandidates` or `index.dims`. A classified AWS failure; `RETRY_EXHAUSTED`;
   * `RESULT_TRUNCATED` from a search or a listing that reads past
   * `maxScanItems`. One failing operation rejects the whole batch.
   *
   * Guarantees: the order the caller wrote is the order the caller observes — a
   * get after a put of the same item sees it, a get before one does not, and a
   * search sees every write that precedes it and none that follow. Operations
   * addressing different items run concurrently, so a batch of ten gets costs
   * about one round trip rather than ten.
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    return guardPublic('store.batch', async () => {
      const results = await this.execute(parseOperations(operations));
      return results as OperationResults<Op>;
    });
  }

  /**
   * Retrieve one item. Overrides the base implementation so the call is
   * guarded here; the operation is the one upstream builds.
   *
   * Accepts: `namespace` — at least one label, each a non-blank identifier of
   * at most 256 bytes, free of `#` and control characters and well-formed
   * UTF-16. A `.` and a `"langgraph"` root are accepted, as the reference store
   * accepts them. `key` — an identifier by the same rules. Together they may
   * compose a sort key of at most 1024 bytes. **No signal**: upstream's
   * `BaseStore.get` takes no parameter for one, so the S3 download an
   * offloaded value costs is not cancellable here. `store.search` is the read
   * that takes one.
   *
   * Returns: the item, or `null` for one that does not exist or has expired.
   *
   * Throws: `VALIDATION` naming `namespace`, `namespace element`, `key` or
   * `sortKey`, and — from the row rather than from the call — `descriptor` for
   * a payload descriptor no reader could make sense of, `s3` for an offloaded
   * row with no offloader configured, `s3Key` for a row addressing an object
   * outside its own path, or `serde` for a payload the configured serializer
   * refuses to reconstruct; `FORMAT_UNSUPPORTED` for an item, or its payload,
   * written by a newer version, which is reported rather than hidden as
   * absent; `PAYLOAD_CORRUPT` for a payload that is no longer the form its row
   * declares; `S3_OFFLOAD_FAILED` for an offloaded payload that cannot be
   * downloaded; `COMPRESSION_LIMIT` for one whose decompressed size would pass
   * the cap; a classified AWS failure; `RETRY_EXHAUSTED`. Not `ABORTED`: there is no
   * signal to fire.
   */
  override async get(namespace: string[], key: string): Promise<Item | null> {
    return guardPublic('store.get', async () => {
      const [item] = await this.execute([
        { kind: 'get', address: parseStoreAddress(namespace, key) },
      ]);
      return item as Item | null;
    });
  }

  /**
   * Store or replace one item. Overrides the base implementation, whose own
   * namespace check threw an error this package does not brand. The value and
   * index are checked by {@link batch}, so LangGraph's own puts hold them too.
   *
   * Accepts: `namespace` and `key` — as {@link get}, plus upstream
   * `BaseStore.put`'s own two rules, which only this method applies: no label
   * holding `.`, and a root other than `"langgraph"`. `value` — an object; `null`
   * is refused, since {@link delete} is how an item is removed. `index` —
   * absent uses the store's configuration, `false` indexes nothing, and field
   * paths override it for this put.
   *
   * Returns: nothing.
   *
   * Throws: `VALIDATION` naming `namespace`, `namespace element`, `key`,
   * `sortKey`, `value` or `index`; `payload` for a value too large to store
   * inline without `s3`, or, once offloaded, larger than
   * `s3.maxDownloadBytes`; a classified AWS failure; `RETRY_EXHAUSTED`.
   */
  override async put(
    namespace: string[],
    key: string,
    value: Parameters<BaseStore['put']>[2],
    index?: Parameters<BaseStore['put']>[3],
  ): Promise<void> {
    return guardPublic('store.put', async () => {
      await this.execute([parsePutArguments(namespace, key, value, index)]);
    });
  }

  /**
   * Remove one item, as upstream does: a put operation carrying `null`.
   *
   * Accepts: `namespace` and `key` — as {@link get}.
   *
   * Returns: nothing. Deleting an item that is not there is not an error —
   * which now describes the outcome rather than the round trip, since the row
   * is read before it is removed.
   *
   * Throws: `VALIDATION` naming `namespace`, `namespace element`, `key` or
   * `sortKey`; a classified AWS failure; `RETRY_EXHAUSTED`. The set of types is
   * unchanged, but the occasions are not: that pre-read is a request like any
   * other, so a delete of a key with **no row** can now fail where it always
   * succeeded. Nothing has been written when it does — no row removed, no
   * object released, no vector touched. A delete the row's revision turns away
   * never reaches a caller at all: it is re-pinned on the row the rejection
   * returned and re-issued, because refusing to remove a row a concurrent put
   * replaced is what stops this call erasing that put.
   *
   * Guarantees: the item is gone, was already gone, or — when three attempts in
   * a row are each turned away by a write that landed since the observation
   * that attempt pinned — is still there and was left alone. That last case
   * **resolves**, logging one `warn` naming the namespace, the key and the
   * attempt count, where the reference store always removes the item;
   * throwing instead would add a failure mode to an interleaving that succeeds
   * today, which every caller deleting in a `finally` would have to handle.
   * Re-run once the key is quiescent. Nothing is released on that path, which
   * is correct: a live row still names the object.
   */
  override async delete(namespace: string[], key: string): Promise<void> {
    return guardPublic('store.delete', async () => {
      await this.execute([{ kind: 'delete', address: parseStoreAddress(namespace, key) }]);
    });
  }

  /**
   * List the distinct namespaces, sorted, optionally filtered and truncated.
   *
   * Accepts: `options.prefix`/`suffix` — labels a namespace can hold, where
   * `'*'` matches any one label. `options.maxDepth` — at least 1.
   * `options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000), defaulting
   * to 100, where `0` returns an empty listing without reading the table.
   * `options.offset` — a non-negative integer, defaulting to 0.
   *
   * Returns: at most `limit` namespaces from `offset`.
   *
   * Throws: `VALIDATION` naming `options`, `options.<key>`, `prefix`,
   * `prefix element`, `suffix`, `suffix element`, `maxDepth`, `limit` or
   * `offset`; `RESULT_TRUNCATED` past `maxScanItems`; `FORMAT_UNSUPPORTED`
   * for an item written by a newer version; a classified AWS failure.
   */
  override async listNamespaces(options: ListNamespacesOptions = {}): Promise<string[][]> {
    return guardPublic('store.listNamespaces', async () => {
      const [namespaces] = await this.execute([parseListNamespacesOptions(options)]);
      return namespaces as string[][];
    });
  }

  /**
   * Search with optional cancellation. Overrides the base implementation, which
   * routes through {@link batch} and therefore cannot carry a signal.
   *
   * Accepts: `namespacePrefix` — labels a namespace can hold; empty spans the
   * whole table. `options.query` —
   * absent or empty ranks nothing. `options.filter` — metadata equality on the
   * item's value. `options.offset` — a non-negative integer, defaulting to 0.
   * `options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000), defaulting
   * to 10, where `0` returns an empty page without a read or an embedding.
   * `options.signal` — aborts the reads.
   *
   * Returns: at most `limit` items from `offset`, each carrying a `score` when
   * a query and an index are configured.
   *
   * Throws: `VALIDATION` naming `namespacePrefix`, `namespacePrefix element`,
   * `filter`, `query`, `offset`, `limit`, `maxSearchCandidates`, `index.dims`,
   * `signal`, or
   * `options.<key>` for a key this package does not read; `ABORTED`;
   * `FORMAT_UNSUPPORTED` for an item, or its payload, written by a newer
   * version — a search reads rows it did not name, so one such row anywhere in
   * the prefix it walks reports rather than being passed over; a classified AWS failure.
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
      const prefix = parseNamespacePrefix(namespacePrefix, 'namespacePrefix');
      assertShape(options, STORE_SEARCH_KEYS, 'options');
      assertSignalLike(options.signal);
      const { signal, ...rest } = options;
      return searchItems(this.context, parseSearch(prefix, rest), signal);
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
   * Throws: `VALIDATION` without both an `index` and a `vectorBackend`, for
   * an empty prefix, for an invalid `signal`, or for `options.<key>` naming a
   * key this package does not read; `RESULT_TRUNCATED` past `maxScanItems`;
   * `FORMAT_UNSUPPORTED` for an item, or its payload, written by a newer
   * version — repairing a backend from a view of the prefix that silently
   * omitted such a row would prune the vectors of items that are still there;
   * a classified AWS failure.
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
   * Throws: exactly what {@link destroy} throws, since it is that call.
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
   * Throws: whatever a resource's own `destroy` raises — but only after every
   * other one has been released, so a client that fails to close never strands
   * the one behind it.
   */
  destroy(): void {
    this.shell.release();
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
   * Throws: `VALIDATION` naming `s3.keyPrefix` on a rule-id collision;
   * a classified AWS failure when the bucket's lifecycle cannot be read or written.
   * @remarks Requires the bucket-level `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` permissions, broader than the object-level
   * CRUD the rest of S3 offload needs — call it once during provisioning, not
   * per request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('store.ensureS3LifecycleRule', () => this.shell.ensureLifecycleRule());
  }
}
