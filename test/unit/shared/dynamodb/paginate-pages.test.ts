import { paginatePages } from '../../../../src/shared/dynamodb/paginate';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/**
 * A cap of 0 used to yield one item before noticing: with a single-item page it
 * returned that item and succeeded, and with a two-item page it threw *after*
 * yielding one. Either way the cap it was given was exceeded.
 */
describe('paginatePages cap validation', () => {
  /**
   * `paginatePages`'s `fetchPage` parameter is typed `Promise<PageResult>`;
   * every fake page below is built synchronously and none of them throw, so
   * a non-async function returning `Promise.resolve(...)` already has type
   * `Promise<PageResult>` and needs neither `async` nor `await`.
   */
  const onePage = () => Promise.resolve({ items: [{ n: 1 }], lastKey: undefined });

  it.each([0, -1, Number.NaN])('refuses maxItems %p before reading anything', async (maxItems) => {
    const read = jest.fn(onePage);
    const rows = paginatePages(read, { maxItems });
    await expect(rows.next()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxItems' },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN])('refuses maxIterations %p', async (maxIterations) => {
    const rows = paginatePages(onePage, { maxIterations });
    await expect(rows.next()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxIterations' },
    });
  });

  it('accepts Infinity as the way to ask for no cap', async () => {
    const rows = paginatePages(onePage, { maxItems: Infinity, maxIterations: Infinity });
    const out = [];
    for await (const row of rows) out.push(row);
    expect(out).toEqual([{ n: 1 }]);
  });

  it('accepts a cap of exactly 1', async () => {
    const rows = paginatePages(onePage, { maxItems: 1 });
    const out = [];
    for await (const row of rows) out.push(row);
    expect(out).toEqual([{ n: 1 }]);
  });
});

describe('paginatePages', () => {
  it('follows lastKey across pages, including an empty middle page', async () => {
    const pages = [
      { items: [{ id: 1 }], lastKey: { k: 1 } },
      { items: [], lastKey: { k: 2 } },
      { items: [{ id: 2 }], lastKey: undefined },
    ];
    let call = 0;
    const result = await collect(paginatePages(() => Promise.resolve(pages[call++])));
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('yields exactly maxItems without truncating when no more data remains', async () => {
    const result = await collect(
      paginatePages(() => Promise.resolve({ items: [{ id: 1 }, { id: 2 }], lastKey: undefined }), {
        maxItems: 2,
      }),
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws RESULT_TRUNCATED when maxItems is hit with more data in the page', async () => {
    await expect(
      collect(
        paginatePages(
          () => Promise.resolve({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], lastKey: undefined }),
          { maxItems: 2 },
        ),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RESULT_TRUNCATED });
  });

  it('throws RESULT_TRUNCATED when maxItems is hit and another page follows', async () => {
    await expect(
      collect(
        paginatePages(() => Promise.resolve({ items: [{ id: 1 }, { id: 2 }], lastKey: { k: 1 } }), {
          maxItems: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RESULT_TRUNCATED });
  });

  it('throws ABORTED before fetching when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        paginatePages(() => Promise.resolve({ items: [], lastKey: undefined }), {
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });

  it('throws RESULT_TRUNCATED when the iteration cap is hit with data remaining', async () => {
    await expect(
      collect(
        paginatePages(() => Promise.resolve({ items: [{ id: 1 }], lastKey: { k: 1 } }), {
          maxIterations: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RESULT_TRUNCATED });
  });

  it('does not truncate when paginating to unbounded completion', async () => {
    const pages = [
      { items: [{ id: 1 }], lastKey: { k: 1 } },
      { items: [{ id: 2 }], lastKey: undefined },
    ];
    let call = 0;
    const result = await collect(
      paginatePages(() => Promise.resolve(pages[call++]), {
        maxItems: Number.POSITIVE_INFINITY,
        maxIterations: Number.POSITIVE_INFINITY,
      }),
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('paginatePages abort normalisation (DDB-05)', () => {
  it('throws the library ABORTED error with the raw reason as cause when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const pages = paginatePages(() => Promise.resolve({ items: [], lastKey: undefined }), {
      signal: controller.signal,
    });
    await expect(pages.next()).rejects.toMatchObject({
      code: ErrorCode.ABORTED,
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
  });
});

describe('paginatePages cap on a page with a trailing key (DDB-06)', () => {
  type Page = { items: object[]; lastKey?: object };
  const pagesFrom = (pages: Page[]) => {
    let next = 0;
    return () => pages[next++] as never;
  };
  async function collectAll(source: AsyncGenerator<object>): Promise<object[]> {
    const out: object[] = [];
    for await (const item of source) out.push(item);
    return out;
  }

  it('yields the complete result when the pages after the cap are empty', async () => {
    const fetchPage = pagesFrom([
      { items: [{ id: 1 }, { id: 2 }], lastKey: { k: 1 } },
      { items: [], lastKey: { k: 2 } },
      { items: [] },
    ]);
    await expect(collectAll(paginatePages(fetchPage, { maxItems: 2 }))).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('still reports truncation when a later page carries an item', async () => {
    const fetchPage = pagesFrom([
      { items: [{ id: 1 }, { id: 2 }], lastKey: { k: 1 } },
      { items: [], lastKey: { k: 2 } },
      { items: [{ id: 3 }] },
    ]);
    await expect(collectAll(paginatePages(fetchPage, { maxItems: 2 }))).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxItems' },
    });
  });

  it('charges the probe against the iteration cap', async () => {
    let calls = 0;
    const fetchPage = () => {
      calls += 1;
      return (
        calls === 1
          ? { items: [{ id: 1 }], lastKey: { k: 0 } }
          : { items: [], lastKey: { k: calls } }
      ) as never;
    };
    await expect(
      collectAll(paginatePages(fetchPage, { maxItems: 1, maxIterations: 3 })),
    ).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxIterations' },
    });
  });

  it('honours the signal while probing', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchPage = () => {
      calls += 1;
      if (calls === 1) return { items: [{ id: 1 }], lastKey: { k: 0 } } as never;
      controller.abort();
      return { items: [], lastKey: { k: calls } } as never;
    };
    await expect(
      collectAll(paginatePages(fetchPage, { maxItems: 1, signal: controller.signal })),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });
});
