import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  API_DOCS_ROOT,
  apiPages,
  declaredFunctions,
  documentedNames,
  internalFunctions,
  internalNamesOn,
  quotedNames,
} from './guards/public-docs';

describe('declaredFunctions', () => {
  it('reads exported, async and generator declarations, and not a nested one', () => {
    const source = 'export async function a() {}\nfunction* b() {}\n  function c() {}';
    expect(declaredFunctions(source)).toEqual(['a', 'b']);
  });
});

describe('documentedNames', () => {
  it("reads a page's own name and every heading under it", () => {
    const page = '# Class: DynamoDBStore\n\n## Methods\n\n### batch()\n\n#### Parameters\n';
    expect(documentedNames(page)).toEqual(['DynamoDBStore', 'Methods', 'batch', 'Parameters']);
  });
});

describe('quotedNames and internalNamesOn', () => {
  it('reads code-formatted names with or without a call', () => {
    expect(quotedNames('see `releaseOwned` and `runBatch()`; `a b` is prose')).toEqual([
      'releaseOwned',
      'runBatch',
    ]);
  });

  it('keeps only the internal ones, each once', () => {
    const page = 'see `releaseOwned`, `put` and `releaseOwned` again';
    expect(internalNamesOn(page, new Set(['releaseOwned']))).toEqual(['releaseOwned']);
  });
});

describe('the generated API reference', () => {
  const pages = apiPages();
  const label = (path: string): string => relative(API_DOCS_ROOT, path).split(sep).join('/');

  it('finds the pages to check, so a broken scan cannot pass silently', () => {
    expect(pages.length).toBeGreaterThanOrEqual(40);
  });

  it('names no internal function a reader of the reference cannot look up', () => {
    const internal = internalFunctions();
    const hits = pages.flatMap((path) =>
      internalNamesOn(readFileSync(path, 'utf8'), internal).map(
        (name) => `${label(path)}: ${name}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  /**
   * A module header opens with `Hides`. On a page other than the package's own,
   * it would mean typedoc took a header for the documentation of the public
   * name declared under it.
   */
  it('carries no module header on the page of a public name', () => {
    const packagePage = resolve(API_DOCS_ROOT, 'README.md');
    const hits = pages
      .filter((path) => path !== packagePage && /^Hides /m.test(readFileSync(path, 'utf8')))
      .map(label);
    expect(hits).toEqual([]);
  });
});
