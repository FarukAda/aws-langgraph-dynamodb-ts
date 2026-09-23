import { metaSortKey } from '../../../../src/checkpointer/internal/keys';
import { listQuery, passesKeyFilters } from '../../../../src/checkpointer/internal/list-scope';
import {
  type ListScope,
  parseListScope,
  type ThreadId,
} from '../../../../src/checkpointer/internal/parse';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem } from '../../../../src/checkpointer/types';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

/** U+1F600 GRINNING FACE: one astral code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';
/** U+FF01 FULLWIDTH EXCLAMATION MARK: one high-BMP code unit, below a surrogate. */
const HIGH_BMP = '！';

function context(): CheckpointerContext {
  return {
    client: {} as never,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  };
}

/** A thread-scoped list whose `before` is `before`, built by the parser. */
function scope(before: string): ListScope & { threadId: ThreadId } {
  const built = parseListScope(
    { configurable: { thread_id: 't', checkpoint_ns: '' } },
    { before: { configurable: { checkpoint_id: before } } },
  );
  if (built.threadId === undefined) throw new Error('scope requires a threadId');
  return { ...built, threadId: built.threadId };
}

const meta = (checkpointId: string): CheckpointMetaItem =>
  ({
    PK: 'CHKPT#t',
    SK: metaSortKey('', checkpointId),
    threadId: 't',
    checkpointNs: '',
    checkpointId,
  }) as CheckpointMetaItem;

/** Whether DynamoDB's `BETWEEN … AND :before` admits `sortKey`, by its own byte order. */
function serverAdmits(sortKey: string, bound: unknown): boolean {
  return Buffer.compare(Buffer.from(sortKey, 'utf8'), Buffer.from(bound as string, 'utf8')) <= 0;
}

const boundOf = (before: string): unknown =>
  listQuery(context(), scope(before)).ExpressionAttributeValues?.[':before'];

/**
 * The same `before` bound is applied twice: once as a DynamoDB key condition
 * on the composed sort key, and once in memory on the checkpoint id. The
 * in-memory pass is only redundant while the two agree, and JavaScript's `<`
 * and the server's byte order do not agree at an astral id.
 */
describe('the in-memory `before` filter admits what the key condition admits', () => {
  it('keeps a row the key condition returned', () => {
    const row = meta(HIGH_BMP);
    expect(serverAdmits(row.SK, boundOf(ASTRAL))).toBe(true);

    expect(passesKeyFilters(row, scope(ASTRAL))).toBe(true);
  });

  it('drops a row the key condition would never return', () => {
    const row = meta(ASTRAL);
    expect(serverAdmits(row.SK, boundOf(HIGH_BMP))).toBe(false);

    expect(passesKeyFilters(row, scope(HIGH_BMP))).toBe(false);
  });
});
