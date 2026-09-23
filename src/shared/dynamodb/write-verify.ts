import { type PayloadDescriptor, PayloadLocation } from '../codec/codec';
import type { DynamoDBDocumentLike } from './client-types';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/**
 * What a post-failure read established about a write whose outcome was
 * ambiguous.
 *
 * - `'landed'` — the row holds this write, so it committed server-side and only
 *   its acknowledgement was lost.
 * - `'not-landed'` — the row was read and holds something else, or nothing, so
 *   this write's own upload is dead and safe to release.
 * - `'unverified'` — the read itself failed, so nothing is established.
 *
 * The third answer is the one that must exist. Folding it into the second made
 * a partition that blocked both the write and this read delete the object a
 * possibly-live row points at, breaking every later read of that item. Leaking
 * one object is recoverable; stranding a live row is not.
 */
export type WriteVerdict = 'landed' | 'not-landed' | 'unverified';

/** The collaborators a verification read needs. */
export interface VerifyDeps {
  client: DynamoDBDocumentLike;
  tableName: string;
  retry?: RetryOptions;
}

/** Which row to read, and which attributes of it to project. */
export interface RowRead {
  key: { PK: string; SK: string };
  /** The attribute carrying the row's identity; always projected. */
  attribute: string;
  /** Further attributes to project, when the caller needs the row itself back. */
  also?: readonly string[];
  /**
   * Attributes holding a payload descriptor, projected as its `location` and
   * `s3Key` only. A cleanup decision needs where the payload lives, never its
   * inline bytes, which can run to hundreds of kilobytes. An attribute named
   * here and as `attribute` or in `also` is projected once, as the descriptor,
   * because DynamoDB refuses two overlapping paths in one projection.
   */
  descriptors?: readonly string[];
}

/**
 * A read, plus what makes the row *this* write's row.
 *
 * `expected` is the string the row must yield. `undefined` means there is
 * nothing to compare — a record with no revision, a checkpoint with nothing
 * offloaded — and no read is spent: with nothing at stake the answer is
 * `'not-landed'`, which releases nothing that exists.
 */
export interface RowProbe extends RowRead {
  /**
   * How the row names the write that holds it: `'attribute'` reads the
   * identity straight out of `attribute`, `'descriptor'` reads the S3 key of
   * the payload descriptor stored there.
   */
  kind: 'attribute' | 'descriptor';
  expected: string | undefined;
}

/** A verification read: what it established, and the row it saw. */
export interface VerifiedWrite {
  verdict: WriteVerdict;
  /** The row as read. Absent when nothing was read, or no row exists. */
  row?: DocItem;
}

/**
 * The S3 key an offloaded descriptor points at.
 *
 * Accepts: any descriptor, or none.
 *
 * Returns: the key, or undefined for an inline or absent payload — "this row
 * names no object", which is what a caller comparing two writes needs.
 *
 * Throws: nothing.
 */
export function offloadedKey(descriptor: PayloadDescriptor | undefined): string | undefined {
  return descriptor?.location === PayloadLocation.S3 ? descriptor.s3Key : undefined;
}

/**
 * The identity `row` carries under `probe`.
 *
 * Accepts: `probe.kind` — `'attribute'` reads the identity straight out of the
 * attribute, `'descriptor'` reads the S3 key of the descriptor stored there.
 * `row` — as read, or undefined when there is none.
 *
 * Returns: the identity, or undefined when the row is absent or carries none.
 *
 * Throws: nothing.
 */
export function identityOf(probe: RowProbe, row: DocItem | undefined): string | undefined {
  const stored = row?.[probe.attribute];
  if (probe.kind === 'attribute') return stored as string | undefined;
  return offloadedKey(stored as PayloadDescriptor | undefined);
}

/**
 * The verdict for a row already in hand.
 *
 * Accepts: `row` — the row a conditional-write rejection carried back, which
 * makes this verdict cost no read at all.
 *
 * Returns: `'landed'` when the row's identity is this write's, `'not-landed'`
 * otherwise. Never `'unverified'`: the row was seen.
 *
 * Throws: nothing.
 */
export function verdictFor(probe: RowProbe, row: DocItem | undefined): WriteVerdict {
  return identityOf(probe, row) === probe.expected ? 'landed' : 'not-landed';
}

/**
 * The projection for `read`, with no attribute name left unused, which DynamoDB
 * also refuses.
 */
function projectionOf(read: RowRead): { expression: string; names: Record<string, string> } {
  const nested = read.descriptors ?? [];
  const whole = [read.attribute, ...(read.also ?? [])].filter((name) => !nested.includes(name));
  const names: Record<string, string> = {};
  const paths: string[] = [];
  whole.forEach((name, index) => {
    names[`#a${index}`] = name;
    paths.push(`#a${index}`);
  });
  nested.forEach((name, index) => {
    names[`#d${index}`] = name;
    paths.push(`#d${index}.#loc`, `#d${index}.#s3k`);
  });
  if (nested.length > 0) Object.assign(names, { '#loc': 'location', '#s3k': 's3Key' });
  return { expression: paths.join(', '), names };
}

/**
 * Read the row a probe names, strongly consistently.
 *
 * Accepts: `read.attribute` — always projected. `read.also` — further
 * attributes, for a caller that needs the row itself back rather than only its
 * identity. `read.descriptors` — descriptor attributes, projected as their
 * `location` and `s3Key` only; each still comes back under its own name, as a
 * map holding those two.
 *
 * Returns: the projected row, or undefined when there is none.
 *
 * Throws: the underlying error, which {@link verifyRow} turns into a verdict
 * and a caller that wants the cause keeps. The two are separate functions
 * because a synthetic error built from a caught one lost the original cause.
 *
 * Guarantees: strongly consistent — a read that may lag is no evidence at all
 * about a write that may have landed.
 */
export async function readRow(deps: VerifyDeps, read: RowRead): Promise<DocItem | undefined> {
  const { expression, names } = projectionOf(read);
  const result = await withDynamoDBRetry(
    (request) =>
      deps.client.get(
        {
          TableName: deps.tableName,
          Key: read.key,
          ConsistentRead: true,
          ProjectionExpression: expression,
          ExpressionAttributeNames: names,
        },
        request,
      ),
    deps.retry,
  );
  return result.Item as DocItem | undefined;
}

/**
 * Read one row back to establish what an ambiguous write actually did.
 *
 * No failure is proof of a non-commit: `withDynamoDBRetry` re-issues a write
 * whose response was lost, and those re-issues can time out at the transport
 * without reaching DynamoDB, so the budget is spent on a `RETRY_EXHAUSTED` error
 * while the row is live. Every caller that is about to delete something on the
 * strength of a failure reads the row first, through here.
 *
 * Accepts: `probe.expected` — the identity that would prove the write landed.
 * `undefined` means there is nothing at stake — a record with no revision, a
 * checkpoint with nothing offloaded — and no read is spent.
 *
 * Returns: the verdict and, when one was read, the row. See
 * {@link WriteVerdict} for what each answer licenses the caller to do.
 *
 * Throws: nothing. A failed read is the `'unverified'` answer, not an error:
 * the caller is already handling a failure and needs a decision, not a second
 * one.
 */
export async function verifyRow(deps: VerifyDeps, probe: RowProbe): Promise<VerifiedWrite> {
  if (probe.expected === undefined) return { verdict: 'not-landed' };
  try {
    const row = await readRow(deps, probe);
    return { verdict: verdictFor(probe, row), row };
  } catch {
    return { verdict: 'unverified' };
  }
}
