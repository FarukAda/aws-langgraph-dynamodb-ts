import { paginatePages } from '../../../../src/shared/dynamodb/paginate-core';
import { AbortError } from '../../../../src/shared/errors/errors';

async function collect(gen) {
  const out = [];
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

  it('stops at maxItems', async () => {
    const result = await collect(
      paginatePages(
        async () => ({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], lastKey: undefined }),
        {
          maxItems: 2,
        },
      ),
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
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

  it('stops at the iteration cap', async () => {
    const result = await collect(
      paginatePages(async () => ({ items: [{ id: 1 }], lastKey: { k: 1 } }), { maxIterations: 3 }),
    );
    expect(result).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }]);
  });
});
