import { runBatch } from '../../../../src/store/internal/batch-plan';
import { parsedSearch } from '../../../shared/helpers/parsed-inputs';

/** The share each operation of `count` concurrent searches is handed under `limit`. */
async function sharesFor(count: number, limit: number): Promise<number[]> {
  const operations = Array.from({ length: count }, (_, index) =>
    parsedSearch({ namespacePrefix: [`ns${index}`] }),
  );
  const shares: number[] = [];
  await runBatch(
    operations,
    (_operation, readConcurrency) => {
      shares.push(readConcurrency);
      return Promise.resolve(null);
    },
    limit,
  );
  return shares;
}

describe('runBatch divides one decode budget between the operations it runs together', () => {
  it('gives a lone search the whole budget', async () => {
    expect(await sharesFor(1, 8)).toEqual([8]);
  });

  it('gives each of four concurrent searches a quarter of it', async () => {
    expect(await sharesFor(4, 8)).toEqual([2, 2, 2, 2]);
  });

  it('never gives an operation less than one', async () => {
    expect(new Set(await sharesFor(20, 8))).toEqual(new Set([1]));
  });
});
