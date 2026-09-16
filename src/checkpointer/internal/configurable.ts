import type { RunnableConfig } from '@langchain/core/runnables';

import { assertSignalLike } from '../../shared/validation/collaborators';
import { assertObjectShape } from '../../shared/validation/option-shape';
import type { CheckpointConfigurable } from '../types';
import { validateCheckpointId, validateCheckpointNs, validateThreadId } from './validation';

/** The thread/namespace/checkpoint identifiers extracted from a config. */
export interface ResolvedConfigurable {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
}

/**
 * Whether `value` is one of the three markers a config treats as "no id here".
 *
 * Accepts: `value` — a checkpoint id as the caller gave it, from
 * `configurable` or from `list`'s `before` bound.
 *
 * Returns: true for exactly `undefined`, `null` and `''`. Not JS truthiness:
 * `0`, `false` and `NaN` are values to validate, and refuse, not absences.
 *
 * Throws: nothing.
 */
export function isAbsentId(value: string | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A config's checkpoint id, resolved the way the reference's `getCheckpointId`
 * does — `checkpoint_id || thread_ts || ''` (`@langchain/langgraph-checkpoint`
 * `dist/base.js:169-171`) — but checked against exactly the three values that
 * fallthrough happens to also treat as absent (`undefined`, `null`, `''`),
 * not full JS truthiness. `checkpoint_id: 0`, `false` or `NaN` therefore still
 * gets validated — and refused — as the identifier it is, on whichever field
 * carried it, rather than silently falling through to `thread_ts` or reading
 * as "the latest" the way a bare `||` would.
 *
 * Accepts: `configurable` — its `checkpoint_id` and `thread_ts`.
 *
 * Returns: the id to use, or `undefined` for "the latest" — chosen only when
 * both `checkpoint_id` and `thread_ts` are one of the three absence markers.
 *
 * Throws: ValidationError naming `checkpoint_id` or `thread_ts`, matching
 * whichever field's value was chosen and failed validation.
 */
function resolveCheckpointId(configurable: CheckpointConfigurable): string | undefined {
  if (!isAbsentId(configurable.checkpoint_id)) {
    validateCheckpointId(configurable.checkpoint_id as string);
    return configurable.checkpoint_id;
  }
  if (!isAbsentId(configurable.thread_ts)) {
    validateCheckpointId(configurable.thread_ts as string, 'thread_ts');
    return configurable.thread_ts;
  }
  return undefined;
}

/**
 * Refuse a `config` whose own shape this package cannot read, before any
 * identifier is read from it. Every reader below starts here, and so does
 * `getDeltaChannelHistory`, which reaches a reader only when it has a channel
 * to walk.
 *
 * Accepts: `config` — must be an object; `null`, `undefined`, an array or any
 * other non-object value is refused. `config.configurable` — absent, or an
 * object. `config.signal` — absent, or `AbortSignal`-shaped.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `config`, `configurable` or `signal`. A
 * `null` or `undefined` config reached a bare `TypeError` reading
 * `configurable`, reported as an `UpstreamError`. A `configurable` that is
 * not an object, `null` included, has no `thread_id` to read, so it was taken
 * for a config naming no thread: `list` scanned every thread in the table. A
 * signal that is not `AbortSignal`-shaped failed only once a request was
 * throttled, inside the wait between retries — as an `UpstreamError`, or as an
 * uncaught exception from that wait's timer.
 */
export function assertConfigShape(config: RunnableConfig): void {
  assertObjectShape(config, 'config');
  if (config.configurable !== undefined) assertObjectShape(config.configurable, 'configurable');
  assertSignalLike(config.signal);
}

/**
 * Whether `config` names no thread, after checking its shape.
 *
 * Accepts: `config` — refused as {@link assertConfigShape} refuses it, before
 * any property is read off it. Both {@link readConfigurable} and
 * {@link readThreadlessConfigurable} branch on this same question before
 * either of them runs, which is why the shape check runs here too: reading
 * `config.configurable` to decide is exactly the read a malformed config must
 * not reach.
 *
 * Returns: whether `config.configurable.thread_id` is absent.
 *
 * Throws: ValidationError naming `config`, `configurable` or `signal`.
 */
export function isThreadless(config: RunnableConfig): boolean {
  assertConfigShape(config);
  return config.configurable?.thread_id === undefined;
}

/**
 * The identifiers of a config that names no thread, validated the same way.
 *
 * Accepts: `config` — refused as {@link assertConfigShape} refuses it.
 * `config.configurable` — its `checkpoint_ns` and `checkpoint_id`, if given.
 *
 * Returns: the resolved identifiers with an empty `threadId`; the caller
 * decides what a missing thread means for its own operation.
 *
 * Throws: ValidationError naming `config`, `configurable` or `signal` for a
 * config of the wrong shape, or naming a malformed `checkpoint_ns`,
 * `checkpoint_id` or `thread_ts`. A config without a thread is still checked
 * for the identifiers it *does* give, which is what the reference saver does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:86-92`, where
 * `checkpoint_ns` is asserted whether or not a thread id is present).
 */
export function readThreadlessConfigurable(config: RunnableConfig): ResolvedConfigurable {
  assertConfigShape(config);
  const configurable = (config.configurable ?? {}) as CheckpointConfigurable;
  const checkpointNs = configurable.checkpoint_ns ?? '';
  validateCheckpointNs(checkpointNs);
  const checkpointId = resolveCheckpointId(configurable);
  return { threadId: '', checkpointNs, checkpointId };
}

/**
 * The thread, namespace and checkpoint a config addresses.
 *
 * Accepts: `config` — refused as {@link assertConfigShape} refuses it.
 * `config.configurable` — `thread_id` is required; `checkpoint_ns` defaults
 * to the root namespace; `checkpoint_id` may also arrive under the legacy
 * `thread_ts` alias.
 *
 * Returns: the three identifiers, with `checkpointId` undefined for "latest".
 *
 * Throws: ValidationError naming `config`, `configurable` or `signal` for a
 * config of the wrong shape, or `thread_id`, `checkpoint_ns`, `checkpoint_id`
 * or `thread_ts` for a malformed identifier.
 */
export function readConfigurable(config: RunnableConfig): ResolvedConfigurable {
  assertConfigShape(config);
  const configurable = (config.configurable ?? {}) as CheckpointConfigurable;
  validateThreadId(configurable.thread_id);
  const checkpointNs = configurable.checkpoint_ns ?? '';
  validateCheckpointNs(checkpointNs);
  const checkpointId = resolveCheckpointId(configurable);
  return { threadId: configurable.thread_id, checkpointNs, checkpointId };
}
