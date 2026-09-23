import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import { partitionKey, sortKey } from '../../../../src/store/internal/keys';
import { parseListOperation } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** U+00E4: sorts with `a` in German and after `z` in Swedish. */
const A_UMLAUT = 'ä';

const row = (namespace: string[]) => ({
  PK: partitionKey(namespace),
  SK: sortKey(namespace, 'k'),
  namespace,
  key: 'k',
});

const items = [row([A_UMLAUT]), row(['z'])];

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

/**
 * Run the rest of the test as though the process had booted on a host whose
 * default locale is `locale`.
 *
 * `localeCompare` with no locale argument *is* "compare in the host's default
 * locale", so replacing it with a collator pinned to that locale is what
 * running on that host does, and it needs no second process.
 */
function asHost(locale: string): jest.SpyInstance {
  const collator = new Intl.Collator(locale);
  return jest.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    other: string,
  ): number {
    return collator.compare(String(this), other);
  });
}

/** The two single-namespace pages a caller gets by asking for offset 0 then 1. */
async function pagedByOffset(): Promise<string[][]> {
  const pages: string[][] = [];
  for (const offset of [0, 1]) {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: items });
    pages.push(
      ...(await listNamespaces(context(client), parseListOperation({ limit: 1, offset }))),
    );
  }
  return pages;
}

/**
 * `listNamespaces` pages by `offset` into the sorted listing, so the order is
 * a position a caller holds between two calls. Bare `localeCompare` sorts in
 * the host's locale, so two hosts answering the same paged listing would cut
 * it in different places and the caller would miss one namespace and see
 * another twice.
 */
describe('listNamespaces orders namespaces the same way on every host', () => {
  it.each(['de', 'sv'])('cuts the same page boundary on a %s host', async (locale) => {
    asHost(locale);

    expect(await pagedByOffset()).toEqual([[A_UMLAUT], ['z']]);
  });

  it('never consults the host locale', async () => {
    const localeCompare = asHost('sv');

    await pagedByOffset();

    expect(localeCompare).not.toHaveBeenCalled();
  });
});
