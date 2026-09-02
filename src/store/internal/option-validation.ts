import type { Embeddings } from '@langchain/core/embeddings';
import type { IndexConfig } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import { validateBaseAdapterOptions } from '../../shared/validation/options';
import { validateInteger } from '../../shared/validation/primitives';
import type { DynamoDBStoreOptions } from '../types';
import { VECTOR_SCORE_DIRECTIONS, type VectorScoreDirection } from './score-direction';

/**
 * Reject an `index` that cannot actually embed. `IndexConfig` mandates
 * `embeddings`, but a JavaScript caller can omit it or pass the wrong shape,
 * and the failure then surfaced as a raw `TypeError` deep inside the first
 * `put()`/`search()` rather than this library's typed error at construction.
 *
 * Both methods are required: documents are embedded with `embedDocuments()`
 * on `put()` and queries with `embedQuery()` on `search()`. `dims` is only
 * compared against returned vectors when it is a positive integer, so a
 * configuration that omits it keeps working.
 */
function assertUsableIndex(index?: IndexConfig): void {
  if (!index) return;
  const embeddings: Partial<Embeddings> | undefined = index.embeddings;
  const missing = (['embedQuery', 'embedDocuments'] as const).find(
    (method) => typeof embeddings?.[method] !== 'function',
  );
  if (missing === undefined) return;
  throw new ValidationError(
    `\`index.embeddings\` must be an Embeddings implementation exposing ${missing}(); ` +
      'documents are embedded with embedDocuments() on put() and queries with embedQuery() ' +
      'on search()',
    'index',
  );
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
  throw new ValidationError(
    `vectorScoreDirection must be one of ${VECTOR_SCORE_DIRECTIONS.join(' | ')}; received ` +
      `${JSON.stringify(direction)}, which would be left in the backend's own direction and ` +
      'could rank a distance backend backwards',
    'vectorScoreDirection',
  );
}

/** Both in-memory caps must be positive integers; 0 would silently return nothing. */
function validateLimits(options: DynamoDBStoreOptions): void {
  if (options.maxScanItems !== undefined) {
    validateInteger(options.maxScanItems, 'maxScanItems', { min: 1 });
  }
  if (options.maxSearchCandidates !== undefined) {
    validateInteger(options.maxSearchCandidates, 'maxSearchCandidates', { min: 1 });
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
 */
export function validateStoreOptions(options: DynamoDBStoreOptions): void {
  validateBaseAdapterOptions(options);
  validateLimits(options);
  if (options.vectorBackend && !options.index) {
    throw new ValidationError(
      'vectorBackend requires a configured `index` (embeddings); without one no embedding ' +
        'is computed, every put would clear the item vector, and search would silently return ' +
        'unranked, score-less results',
      'vectorBackend',
    );
  }
  assertUsableIndex(options.index);
  assertScoreDirection(options.vectorScoreDirection);
}
