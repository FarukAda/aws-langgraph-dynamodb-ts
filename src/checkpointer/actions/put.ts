/**
 * Hides what it takes for a checkpoint to land exactly once.
 *
 * The META and PAYLOAD rows go out as one transaction under a request token
 * drawn once, and a failure with S3 offload configured is read back before
 * any upload is released, so a lost acknowledgement reports success and only a
 * confirmed non-commit cleans up (record 6). Every channel value is stored
 * whatever `newVersions` says (record 10). A caller gets back the config that
 * addresses the stored checkpoint and none of this.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/codec';
import { cleanUpS3Orphans } from '../../shared/codec/s3/offloader';
import {
  offloadedKey,
  type RowProbe,
  transactIdempotently,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/idempotent-write';
import { rowKeyOf } from '../../shared/dynamodb/table-schema';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { parsePutRequest } from '../internal/parse';
import {
  buildCheckpointRows,
  type CheckpointMetaRow,
  type CheckpointPayloadRow,
} from '../internal/rows';
import type { CheckpointerContext } from '../internal/setup';

/**
 * Persist a checkpoint and its metadata as a transactional pair of META and
 * PAYLOAD items, returning the config that addresses the stored checkpoint. The
 * incoming `checkpoint_id` (if any) becomes the new checkpoint's parent.
 *
 * **Every channel value the checkpoint carries is stored.** `newVersions` is
 * accepted because `BaseCheckpointSaver.put` declares it
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:68`) and is
 * deliberately ignored: narrowing the stored values to the ones it names, and
 * carrying the rest forward from the parent, made a put whose `newVersions` is
 * `{}` write no values at all. LangGraph passes `{}` when forking a checkpoint
 * and when writing an empty-checkpoint update (`@langchain/langgraph@1.4.13`
 * `dist/pregel/index.js:668` and `:613`), so that put silently dropped user
 * state. The reference saver does not narrow either: `MemorySaver.put` takes
 * three parameters and stores the whole checkpoint (`dist/memory.js:206`).
 *
 * Accepts: `config` — its `checkpoint_id`, when present, becomes the new
 * checkpoint's parent. `checkpoint.id` — validated as the sort-key segment it
 * becomes. `metadata` — stored beside it, on the light row a listing reads.
 * `config.signal` — cancels the writes' retries; checked before anything is
 * encoded.
 *
 * Returns: the config addressing the stored checkpoint, which is what the
 * caller passes back to continue the thread.
 *
 * Throws: `VALIDATION` naming `config`, `configurable` or `signal` for a
 * config of the wrong shape, `thread_id`, `checkpoint_ns`, `checkpoint_id` or
 * `thread_ts` for a malformed identifier, `checkpoint` for a `null` or
 * `undefined` checkpoint, `checkpoint_id` for a malformed `checkpoint.id`,
 * `payload` for a payload too large to store inline without `s3`, or `s3Key`
 * for an offloaded object's key over S3's cap; `S3_OFFLOAD_FAILED`; whatever
 * the transaction throws once the outcome is established.
 *
 * Guarantees: both rows land or neither does — they are one transaction, so a
 * META row never names a payload that is not there. That transaction goes out
 * under a client request token drawn once, with the request it travels on, so
 * a retry that follows a lost acknowledgement is discarded by the service
 * rather than applied a second time. Writing the same `checkpoint.id` again
 * replaces both, which is what a retry and a repair tool both need; the objects
 * the replaced rows named are not deleted by the put, and are left to the
 * lifecycle rule. A payload the serde refuses is refused before any write and
 * releases whatever the same call had already uploaded, so an encode that fails
 * halfway leaves nothing behind either. On failure with S3 offload configured
 * the row carrying an offloaded descriptor is read back before any upload is
 * deleted (see {@link verifyCheckpointLanded}): a transaction that committed
 * and lost its response is reported as success, a confirmed non-commit cleans
 * up the objects this call uploaded, and an unverifiable outcome leaks them
 * rather than risk stranding a live row. Each put uploads under an object id of
 * its own, so no row another put commits names this call's uploads.
 */
export async function putCheckpoint(
  context: CheckpointerContext,
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  _newVersions?: ChannelVersions,
): Promise<RunnableConfig> {
  const request = parsePutRequest(config, checkpoint, metadata);
  const { threadId, checkpointNs, checkpointId } = request.address;
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const { meta, payload } = await buildCheckpointRows(context, request, ttlTimestamp);
  const stored: RunnableConfig = {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
  };
  try {
    // One request, one token, re-sent unchanged for every attempt of the
    // budget — which is what the token is worth here, since a token minted on
    // a request the retry closure rebuilt would be a fresh one per attempt and
    // would deduplicate nothing.
    //
    // Neither row is guarded, so nothing else can turn a re-send away: a retry
    // that follows a lost acknowledgement puts both rows back, and one
    // arriving after a `deleteThread` removed them puts back two live rows
    // naming two objects that call has already released. Inside the service's
    // idempotency window the token discards it instead. The pair is atomic, so
    // what that window covers is the pair: a re-send either re-applies both
    // rows or neither.
    //
    // A condition on either row is not the alternative it looks like. Two
    // guarded items would make one genuine race cancel with two
    // `ConditionalCheckFailed` reasons, and `conditionalCheckFailure` reads a
    // cancellation as a guard rejection only while a single cause remains — so
    // the race would surface as an unrecognised non-retryable error.
    //
    // Because neither row is guarded, the precondition on what a token
    // guarantees — see {@link transactIdempotently} — never bites on the rows
    // themselves: no condition here can turn an attempt away, so an attempt
    // either committed the pair, and its re-send is discarded, or committed
    // nothing. It does bite on the transaction, which a conflict with a
    // concurrent writer of the same id can still cancel: a cancellation
    // completes nothing and is cached as nothing, so the attempt after one is
    // a fresh evaluation rather than a replay. That is the wanted outcome here
    // — the pair did not land, so it must still land — and it is why the
    // token's promise is worded about a write that *committed* rather than one
    // that was merely sent.
    //
    // The deadline that helper carries is what keeps this budget inside the
    // window the token is honoured for. The token enforces no window itself,
    // and a re-send arriving after it has closed is simply a new request: both
    // rows land again, over whatever has replaced them and after whatever
    // released the objects they name.
    await transactIdempotently(
      context,
      [
        { Put: { TableName: context.tableName, Item: meta } },
        { Put: { TableName: context.tableName, Item: payload } },
      ],
      { signal: request.signal },
    );
  } catch (error) {
    if (!context.offloader) throw error;
    const verdict = await verifyCheckpointLanded(context, meta, payload);
    if (verdict === 'landed') {
      context.logger.debug('put: transaction committed although its response was lost', {
        threadId,
        checkpointId,
      });
      return stored;
    }
    if (verdict === 'not-landed') {
      await cleanUpS3Orphans(context.offloader, {
        keys: collectS3Keys([meta.metadata, payload.checkpoint]),
        operation: 'put',
        logger: context.logger,
      });
    }
    throw error;
  }
  return stored;
}

/**
 * Pick the row carrying an offloaded descriptor, projected to that
 * descriptor's `location` and `s3Key`. The META and PAYLOAD rows commit in one
 * transaction, so one of them is enough; with neither offloaded there is
 * nothing to protect and no read to spend, which {@link verifyRow} answers
 * `'not-landed'` for an absent `expected`.
 */
function chooseProbe(meta: CheckpointMetaRow, payload: CheckpointPayloadRow): RowProbe {
  const metaKey = offloadedKey(meta.metadata);
  if (metaKey !== undefined) {
    return {
      key: rowKeyOf(meta),
      kind: 'descriptor',
      attribute: 'metadata',
      expected: metaKey,
      descriptors: ['metadata'],
    };
  }
  return {
    key: rowKeyOf(payload),
    kind: 'descriptor',
    attribute: 'checkpoint',
    expected: offloadedKey(payload.checkpoint),
    descriptors: ['checkpoint'],
  };
}

/**
 * Read one of the two rows back after the META+PAYLOAD transaction failed and
 * report what that failure actually did — never assuming it did nothing.
 *
 * Accepts: `meta` and `payload` — the two rows the failed transaction carried.
 * Whichever of them has something offloaded is the one read back; a fully
 * inline write has no object at stake and spends no read.
 *
 * Returns: the verdict. See {@link WriteVerdict} for what each answer licenses
 * the caller to do. `'landed'` when the row holds this attempt's key,
 * `'not-landed'` when it holds another or none, `'unverified'` when the read
 * failed.
 *
 * Throws: nothing — a failed read is the `'unverified'` answer.
 *
 * Guarantees: both descriptors' keys end in the object id this put drew, which
 * no other put uses. The row holds this attempt's key only if this put's
 * transaction committed, and the other row commits with it, so one read decides
 * the landing. A row holding any other key was committed by another put, whose
 * rows name only that put's objects, so a `'not-landed'` answer leaves both of
 * this put's uploads named by no row.
 */
export async function verifyCheckpointLanded(
  context: CheckpointerContext,
  meta: CheckpointMetaRow,
  payload: CheckpointPayloadRow,
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, chooseProbe(meta, payload));
  return verdict;
}
