import type { IndexConfig, Item, SearchItem } from '@langchain/langgraph-checkpoint';

import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { failureLabel } from '../../shared/errors/base-error';
import { validationError } from '../../shared/errors/errors';
import { truncateForLog, truncateLabelsForLog } from '../../shared/logging/truncate';
import type { VectorBackend, VectorMatch } from '../vector-backend';
import { getItem } from './get-item';
import { type ParsedSearch, parseStoreAddress, type StoreAddress } from './parse';
import { namespaceMatchesPrefix } from './rows';
import { toRelevanceScores } from './score-direction';
import { passesFilter } from './search-filter';
import { assertVectorDims } from './semantic-search';
import type { StoreContext } from './setup';

/**
 * Warn when a backend's own ordering disagrees with its scores. A backend
 * returning a raw distance still hands back nearest-first, so the order looks
 * right while every score means the opposite of what {@link VectorMatch.score}
 * promises — ascending scores are that exact signature. Results are never
 * reordered on this basis: a correctly-scored backend's order is authoritative.
 */
function warnOnNonDescendingScores(
  context: StoreContext,
  matches: VectorMatch[],
  namespacePrefix: string[],
): void {
  const descending = matches.every(
    (match, position) => position === 0 || matches[position - 1].score >= match.score,
  );
  if (descending) return;
  context.logger.warn(
    'search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance ' +
      '(higher is better), not a distance — results are forwarded in the order the backend gave',
    { namespacePrefix: truncateLabelsForLog(namespacePrefix) },
  );
}

/**
 * The address a backend match names, parsed, or `undefined` — logged — when it
 * names one this store cannot form. A backend returning a namespace element
 * that holds the reserved separator would otherwise turn a whole search into a
 * `VALIDATION` error over one bad key. The address is checked here rather than
 * read back off the error `getItem` raises: the read raises a `VALIDATION` error
 * of its own for a payload it cannot honour — an offloaded row read with no
 * `s3` configured, a descriptor that is not one, an `s3Key` outside the row's
 * path — and those are reads that did not happen, not items that are not
 * there, so telling them apart by code alone dropped them as well.
 *
 * The line quotes the address the backend gave, bounded: this fires in the
 * branch where `parseStoreAddress` refused it, one line per bad match, and
 * nothing this package ran bounded either the labels or how many of them there
 * are. The `reason` goes through the same cap, though it is the only one of
 * these that cannot exceed it: what this `catch` binds is always
 * `parseStoreAddress`'s own `VALIDATION` error, whose code is a literal of this
 * package's. It is cut anyway so the rule reads the same at every site that
 * names a failure — a name and a message are the two halves of what the
 * failure was, and `message` is bounded where `redactedMessage` relays it —
 * and so that a later refusal thrown from somewhere else does not arrive
 * unbounded because this one site was reasoned about individually.
 */
function addressOf(context: StoreContext, match: VectorMatch): StoreAddress | undefined {
  try {
    return parseStoreAddress(match.namespace, match.key);
  } catch (error) {
    context.logger.warn('search: skipped an unusable vectorBackend match', {
      namespace: truncateLabelsForLog(match.namespace),
      key: truncateForLog(match.key),
      reason: truncateForLog(failureLabel(error as Error)),
    });
    return undefined;
  }
}

/**
 * Read the canonical item a backend match points at, or `null` when the match
 * names an address this store cannot form (see {@link addressOf}).
 *
 * Every failure of the read itself reaches the caller. A throttled or cancelled
 * read says nothing about whether the item is there, so treating it as an
 * absent match handed back a page silently one item short, with only a `warn`
 * the default logger never prints to say so — while the in-DynamoDB path fails
 * the same search outright.
 */
async function fetchMatch(
  context: StoreContext,
  match: VectorMatch,
  signal?: AbortSignal,
): Promise<Item | null> {
  const address = addressOf(context, match);
  if (address === undefined) return null;
  return getItem(context, address, signal);
}

/** Stable, collision-free identity for a match, so one call reads each item once. */
function matchIdentity(match: VectorMatch): string {
  return JSON.stringify([match.namespace, match.key]);
}

/**
 * Read the canonical item behind every match this call has not read yet, into
 * `fetched`.
 *
 * Each round asks the backend for a larger `topK`, and the answer *contains*
 * the previous round's matches, so re-reading them cost one DynamoDB read — and
 * one S3 download for an offloaded item — per match per round. Remembering the
 * reads bounds a whole search at one read per distinct match. The same map also
 * covers a backend that returns one key twice in a single round.
 *
 * What a caller trades for it: an item changed between two rounds is answered
 * from the first read. A search is not a transaction and the rounds are
 * milliseconds apart, so the alternative — re-reading to catch a write that may
 * as well have landed a moment later — buys nothing.
 */
async function fetchUnseen(
  context: StoreContext,
  scoped: readonly VectorMatch[],
  fetched: Map<string, Item | null>,
  signal?: AbortSignal,
): Promise<void> {
  const unseen = new Map<string, VectorMatch>();
  for (const match of scoped) {
    const identity = matchIdentity(match);
    if (!fetched.has(identity)) unseen.set(identity, match);
  }
  const pending = [...unseen.values()];
  const items = await mapWithConcurrency(
    pending,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (match) => fetchMatch(context, match, signal),
  );
  pending.forEach((match, index) => fetched.set(matchIdentity(match), items[index]));
}

/**
 * Rank a search through a configured vector backend.
 *
 * Accepts: `search.query` — non-empty; the caller checks that before choosing
 * this path. `search.offset`/`search.limit` — the page, whose end (`offset + limit`)
 * must fit within `maxSearchCandidates`, since that many matches have to be
 * fetched to fill it. `search.filter` — applied to the canonical item, not to
 * whatever the backend stored, so a filter is never answered from a stale
 * vector.
 *
 * Returns: the page's items in the backend's order, each carrying the relevance
 * score for its vector. Fewer than `limit` items means the backend has no more
 * matches under the prefix, not that the page was cut short.
 *
 * Throws: `VALIDATION` naming `index.dims` when the query embeds to a
 * different width than the index declares, and naming `maxSearchCandidates`
 * either for a page larger than the cap or when the filter leaves the page short
 * at the cap — the same answer the in-DynamoDB ranker gives, rather than a
 * silently short page. Whatever a canonical read throws — a read that did not
 * happen is not an item that is not there — since a match this store cannot
 * address is dropped before its read rather than caught after it (see
 * {@link addressOf}). Whatever the embeddings model and the backend throw.
 *
 * Guarantees: DynamoDB stays canonical. A match whose item has since been
 * deleted or lies outside the prefix is dropped and the search asks the backend
 * for more, so a stale or over-broad index costs results only in latency. A
 * match whose read *fails* is not dropped: the page a caller receives is never
 * shorter than the matches that exist, which is what the in-DynamoDB path
 * already promises. Items are fetched with the same bounded concurrency as the
 * in-DynamoDB path, and each distinct match is read once for the whole call
 * however many rounds it takes (see {@link fetchUnseen}).
 */
export async function searchViaBackend(
  context: StoreContext,
  backend: VectorBackend,
  index: IndexConfig,
  search: ParsedSearch,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const { offset, limit } = search;
  const queryVector = await index.embeddings.embedQuery(search.query as string);
  assertVectorDims(index, queryVector, 'query');
  const need = offset + limit;
  if (need > context.maxSearchCandidates) {
    throw validationError(
      `Requested page (offset ${offset} + limit ${limit} = ${need}) exceeds maxSearchCandidates ` +
        `(${context.maxSearchCandidates}); narrow the page or raise maxSearchCandidates`,
      'maxSearchCandidates',
    );
  }
  let topK = Math.min(need, context.maxSearchCandidates);
  let results: SearchItem[];
  const fetched = new Map<string, Item | null>();
  for (;;) {
    const matches = toRelevanceScores(
      await backend.query(search.namespacePrefix, queryVector, topK),
      context.vectorScoreDirection,
    );
    warnOnNonDescendingScores(context, matches, search.namespacePrefix);
    const scoped = matches.filter((match) =>
      namespaceMatchesPrefix(match.namespace, search.namespacePrefix),
    );
    await fetchUnseen(context, scoped, fetched, signal);
    results = [];
    for (const match of scoped) {
      const item = fetched.get(matchIdentity(match));
      if (item && passesFilter(item, search.filter)) results.push({ ...item, score: match.score });
    }
    if (results.length >= need || matches.length < topK) break;
    if (topK >= context.maxSearchCandidates) {
      /** The backend still holds matches, but the filter left the page short at the cap: the same answer the in-DB ranker gives, not a silently short page. */
      throw validationError(
        `Semantic search collected ${results.length} of ${need} matches within maxSearchCandidates ` +
          `(${context.maxSearchCandidates}); narrow the filter or raise maxSearchCandidates`,
        'maxSearchCandidates',
      );
    }
    topK = Math.min(topK * 2, context.maxSearchCandidates);
  }
  return results;
}
