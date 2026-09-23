import type { IndexConfig } from '@langchain/langgraph-checkpoint';

import { MAX_SCAN_ITEMS, MAX_SEARCH_CANDIDATES } from '../../shared/constants';
import { validationError } from '../../shared/errors/errors';
import { assertMembers, EMBEDDINGS_MEMBERS } from '../../shared/validation/collaborators';
import { allKeysOf, assertShape } from '../../shared/validation/option-shape';
import { validateBaseAdapterOptions } from '../../shared/validation/options';
import { validateInteger, validateStringArray } from '../../shared/validation/primitives';
import type { DynamoDBStoreOptions } from '../types';
import { VECTOR_SCORE_DIRECTIONS, type VectorScoreDirection } from './score-direction';

/**
 * The keys `IndexConfig` declares. The type is upstream's, but this package is
 * what reads `index`, so a key missing from this list — a misspelling, or one
 * a later upstream release adds — is one it would silently ignore; refusing it
 * is what tells the caller their setting is not in effect.
 */
const INDEX_KEYS = allKeysOf<IndexConfig>({
  dims: 'dims',
  embeddings: 'embeddings',
  fields: 'fields',
});

/**
 * Reject an `index` that cannot actually embed. `IndexConfig` mandates
 * `embeddings`, but a JavaScript caller can omit it or pass the wrong shape,
 * and the failure then surfaced as a raw `TypeError` deep inside the first
 * `put()`/`search()` rather than this library's typed error at construction.
 *
 * Both methods are required: documents are embedded with `embedDocuments()`
 * on `put()` and queries with `embedQuery()` on `search()`.
 *
 * The keys are checked first, so `{ dims, embed }` names the misspelt `embed`
 * rather than the `embeddings` it displaced. `null` is refused like any other
 * value that is not an object, where it used to mean no index; only
 * `undefined` does. `fields`, when given, must be an array of strings, the
 * rule a put's own `index` argument follows: a string reached the first put
 * and failed there as an upstream error.
 */
function assertUsableIndex(index: IndexConfig | undefined): void {
  if (index === undefined) return;
  assertShape(index, INDEX_KEYS, 'index');
  assertMembers(index.embeddings, EMBEDDINGS_MEMBERS, 'index.embeddings');
  if (index.fields !== undefined) validateStringArray(index.fields, 'index.fields');
}

/**
 * Reject a `vectorScoreDirection` outside the declared union.
 *
 * {@link toRelevanceScores} treats anything it does not recognise as a no-op —
 * the only safe default, since guessing would invert a ranking — so a mistyped
 * or config-file-sourced value would otherwise leave a distance backend ranked
 * backwards with no error and no warning anywhere. Same premise as
 * {@link assertUsableIndex}: a JavaScript caller can pass a string the type
 * never admits.
 */
function assertScoreDirection(direction?: VectorScoreDirection): void {
  if (direction === undefined || VECTOR_SCORE_DIRECTIONS.includes(direction)) return;
  throw validationError(
    `vectorScoreDirection must be one of ${VECTOR_SCORE_DIRECTIONS.join(' | ')}; received ` +
      `${JSON.stringify(direction)}, which would be left in the backend's own direction and ` +
      'could rank a distance backend backwards',
    'vectorScoreDirection',
  );
}

/** Both in-memory caps must be positive integers; 0 would silently return nothing. */
function validateLimits(options: DynamoDBStoreOptions): void {
  if (options.maxScanItems !== undefined) {
    validateInteger(options.maxScanItems, 'maxScanItems', { min: 1, max: MAX_SCAN_ITEMS });
  }
  if (options.maxSearchCandidates !== undefined) {
    validateInteger(options.maxSearchCandidates, 'maxSearchCandidates', {
      min: 1,
      max: MAX_SEARCH_CANDIDATES,
    });
  }
}

/**
 * Validate every store option at construction, shared options first.
 *
 * A `vectorBackend` without an `index` is rejected outright rather than
 * silently degrading: with no embeddings configured, every `put` would compute
 * no vector and instruct the backend to *delete* the item's entry instead of
 * indexing it, and `search()` would fall through to an unranked scan-order
 * listing with no `.score` field and no error — a semantic query returning a
 * normal-looking but meaningless response. `reconcileVectorIndex` already
 * refused this exact misconfiguration.
 *
 * Accepts: every option the store takes. The types describe the intended
 * shapes; this runs for the JavaScript caller the types never see, and for the
 * combinations no type can express — a backend without an index, an `index`
 * key `IndexConfig` does not declare, an `embeddings` object missing a method,
 * a direction outside its union.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming the offending option. Every failure is raised
 * at construction, where the fix is, rather than at the first put or search.
 */
export function validateStoreOptions(options: DynamoDBStoreOptions): void {
  validateBaseAdapterOptions(options);
  validateLimits(options);
  if (options.vectorBackend && !options.index) {
    throw validationError(
      'vectorBackend requires a configured `index` (embeddings); without one no embedding ' +
        'is computed, every put would clear the item vector, and search would silently return ' +
        'unranked, score-less results',
      'vectorBackend',
    );
  }
  assertUsableIndex(options.index);
  assertScoreDirection(options.vectorScoreDirection);
}
