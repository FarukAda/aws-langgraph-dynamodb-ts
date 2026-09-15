import {
  type ListScope,
  listQuery,
  listScan,
  passesKeyFilters,
  passesMetadataFilter,
  readListScope,
} from '../../../../src/checkpointer/internal/list-scope';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem } from '../../../../src/checkpointer/types';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

function context(): CheckpointerContext {
  return {
    client: {} as never,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  } as CheckpointerContext;
}

const scope = (over: Partial<ListScope> = {}): ListScope => ({
  threadId: 't',
  checkpointNs: '',
  checkpointId: undefined,
  before: undefined,
  filter: undefined,
  limit: undefined,
  signal: undefined,
  ...over,
});

const inline = (value: unknown) => ({
  location: 'INLINE' as never,
  serdeType: 'json',
  schemaVersion: 1,
  compressed: false,
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

const meta = (over: Partial<CheckpointMetaItem> = {}): CheckpointMetaItem =>
  ({
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata: inline({}),
    ...over,
  }) as CheckpointMetaItem;

describe('readListScope', () => {
  it('reads every identifier and option a list covers', () => {
    const signal = new AbortController().signal;
    expect(
      readListScope(
        { configurable: { thread_id: 't', checkpoint_ns: 'ns', checkpoint_id: 'c1' }, signal },
        { before: { configurable: { checkpoint_id: 'c9' } }, limit: 5, filter: { source: 'loop' } },
      ),
    ).toEqual({
      threadId: 't',
      checkpointNs: 'ns',
      checkpointId: 'c1',
      before: 'c9',
      limit: 5,
      filter: { source: 'loop' },
      signal,
    });
  });

  /** Undefined and "every" are different answers: one scopes the read, the other spans it. */
  it('leaves an absent thread and namespace undefined rather than defaulting them', () => {
    const resolved = readListScope({ configurable: {} }, undefined);
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.checkpointNs).toBeUndefined();
    expect(resolved.limit).toBeUndefined();
  });

  /** A config naming no thread is still checked for the identifiers it does give. */
  it('validates the identifiers a thread-less config carries', () => {
    expect(() => readListScope({ configurable: { checkpoint_ns: 'a#b' } }, undefined)).toThrow(
      /checkpoint_ns/,
    );
  });

  it('refuses a non-integer limit before any request is built', () => {
    expect(() => readListScope({ configurable: { thread_id: 't' } }, { limit: 1.5 })).toThrow(
      /limit/,
    );
    expect(() => readListScope({ configurable: { thread_id: 't' } }, { limit: 0 })).not.toThrow();
  });
});

describe('listQuery', () => {
  it('scopes to one namespace and passes an unfiltered limit through as the page size', () => {
    const input = listQuery(context(), {
      ...scope({ checkpointNs: 'ns', limit: 7 }),
      threadId: 't',
    });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'CHKPT#t',
      ':skPrefix': 'META#ns#',
    });
    expect(input.Limit).toBe(7);
  });

  /**
   * With a filter, rows are dropped after the read, so passing the limit to
   * DynamoDB would cut the page short of matches that exist.
   */
  it('withholds the limit when a metadata filter may drop rows', () => {
    const input = listQuery(context(), {
      ...scope({ checkpointNs: 'ns', limit: 7, filter: { source: 'loop' } }),
      threadId: 't',
    });
    expect(input.Limit).toBeUndefined();
  });

  it('spans every namespace of the thread when none is given', () => {
    const input = listQuery(context(), { ...scope({ checkpointNs: undefined }), threadId: 't' });
    expect(input.ExpressionAttributeValues).toMatchObject({ ':skPrefix': 'META#' });
  });

  /** Across namespaces the ids do not share one order, so the bound cannot be a key condition. */
  it('bounds the key range with `before` only when the namespace is explicit', () => {
    const scoped = listQuery(context(), {
      ...scope({ checkpointNs: 'ns', before: 'c9' }),
      threadId: 't',
    });
    expect(scoped.ExpressionAttributeValues?.[':before']).toBe('META#ns#c9');
    const spanning = listQuery(context(), {
      ...scope({ checkpointNs: undefined, before: 'c9' }),
      threadId: 't',
    });
    expect(spanning.ExpressionAttributeValues?.[':before']).toBeUndefined();
  });
});

describe('listScan', () => {
  it('filters the table to this adapter s META rows, narrowed to a namespace when given', () => {
    expect(listScan(context(), scope({ checkpointNs: 'ns' })).ExpressionAttributeValues).toEqual({
      ':pk': 'CHKPT#',
      ':sk': 'META#ns#',
    });
    expect(
      listScan(context(), scope({ checkpointNs: undefined })).ExpressionAttributeValues,
    ).toEqual({ ':pk': 'CHKPT#', ':sk': 'META#' });
  });
});

describe('passesKeyFilters', () => {
  it('keeps a row strictly older than `before` and drops the boundary itself', () => {
    expect(passesKeyFilters(meta({ checkpointId: 'c1' }), scope({ before: 'c2' }))).toBe(true);
    expect(passesKeyFilters(meta({ checkpointId: 'c2' }), scope({ before: 'c2' }))).toBe(false);
    expect(passesKeyFilters(meta({ checkpointId: 'c3' }), scope({ before: 'c2' }))).toBe(false);
  });

  /** On the scan path the key condition cannot narrow these, so the filter must. */
  it('narrows to the requested namespace and checkpoint', () => {
    expect(passesKeyFilters(meta({ checkpointNs: 'other' }), scope({ checkpointNs: 'ns' }))).toBe(
      false,
    );
    expect(passesKeyFilters(meta({ checkpointId: 'c1' }), scope({ checkpointId: 'c2' }))).toBe(
      false,
    );
    expect(
      passesKeyFilters(meta(), scope({ checkpointNs: undefined, checkpointId: undefined })),
    ).toBe(true);
  });
});

describe('passesMetadataFilter', () => {
  it('passes every row and decodes nothing when no filter is given', async () => {
    const verdict = await passesMetadataFilter(context(), meta(), scope());
    expect(verdict).toEqual({ pass: true });
  });

  it('returns the decoded metadata with the verdict, so the assembly decodes once', async () => {
    const row = meta({ metadata: inline({ source: 'loop', step: 2 }) as never });
    const verdict = await passesMetadataFilter(
      context(),
      row,
      scope({ filter: { source: 'loop' } }),
    );
    expect(verdict).toEqual({ pass: true, metadata: { source: 'loop', step: 2 } });
  });

  it('rejects a row whose metadata does not match every clause', async () => {
    const row = meta({ metadata: inline({ source: 'input' }) as never });
    await expect(
      passesMetadataFilter(context(), row, scope({ filter: { source: 'loop' } })),
    ).resolves.toEqual({ pass: false });
  });

  /** One odd row must not fail a listing over many. */
  it('rejects rather than throws when the metadata is not an object', async () => {
    const row = meta({ metadata: inline(null) as never });
    await expect(
      passesMetadataFilter(context(), row, scope({ filter: { source: 'loop' } })),
    ).resolves.toEqual({ pass: false });
  });
});

describe('readListScope error shape', () => {
  it('names the offending option on the error it raises', async () => {
    try {
      readListScope({ configurable: { thread_id: 't' } }, { limit: 1.5 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode; context: { field?: string } }).code).toBe(
        ErrorCode.VALIDATION,
      );
      expect((error as { context: { field?: string } }).context.field).toBe('limit');
    }
  });
});
