import { paginatePages } from '../../../../src/shared/dynamodb/paginate-core';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { AbortError, ResultTruncatedError } from '../../../../src/shared/errors/errors';

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('paginatePages', () => {
  it('follows lastKey across pages, including an empty middle page', async () => {
    const pages = [
      { items: [{ id: 1 }], lastKey: { k: 1 } },
      { items: [], lastKey: { k: 2 } },
      { items: [{ id: 2 }], lastKey: undefined },
    ];
    let call = 0;
    const result = await collect(paginatePages(async () => pages[call++]));
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('yields exactly maxItems without truncating when no more data remains', async () => {
    const result = await collect(
      paginatePages(async () => ({ items: [{ id: 1 }, { id: 2 }], lastKey: undefined }), {
        maxItems: 2,
      }),
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws ResultTruncatedError when maxItems is hit with more data in the page', async () => {
    await expect(
      collect(
        paginatePages(
          async () => ({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], lastKey: undefined }),
          { maxItems: 2 },
        ),
      ),
    ).rejects.toBeInstanceOf(ResultTruncatedError);
  });

  it('throws ResultTruncatedError when maxItems is hit and another page follows', async () => {
    await expect(
      collect(
        paginatePages(async () => ({ items: [{ id: 1 }, { id: 2 }], lastKey: { k: 1 } }), {
          maxItems: 2,
        }),
      ),
    ).rejects.toBeInstanceOf(ResultTruncatedError);
  });

  it('throws AbortError before fetching when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        paginatePages(async () => ({ items: [], lastKey: undefined }), {
          signal: controller.signal,
        }),
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('throws ResultTruncatedError when the iteration cap is hit with data remaining', async () => {
    await expect(
      collect(
        paginatePages(async () => ({ items: [{ id: 1 }], lastKey: { k: 1 } }), {
          maxIterations: 3,
        }),
      ),
    ).rejects.toBeInstanceOf(ResultTruncatedError);
  });

  it('does not truncate when paginating to unbounded completion', async () => {
    const pages = [
      { items: [{ id: 1 }], lastKey: { k: 1 } },
      { items: [{ id: 2 }], lastKey: undefined },
    ];
    let call = 0;
    const result = await collect(
      paginatePages(async () => pages[call++], {
        maxItems: Number.POSITIVE_INFINITY,
        maxIterations: Number.POSITIVE_INFINITY,
      }),
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('paginatePages abort normalisation (DDB-05)', () => {
  it('throws the library AbortError with the raw reason as cause when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const pages = paginatePages(async () => ({ items: [], lastKey: undefined }), {
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
    return async () => pages[next++] as never;
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
    const fetchPage = async () => {
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
    const fetchPage = async () => {
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
