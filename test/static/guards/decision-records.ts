import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SRC_ROOT } from './source-files';

const DECISIONS = resolve(SRC_ROOT, '..', 'docs', 'decisions');

/** The statuses a record may carry. A reversed record keeps its file. */
export const RECORD_STATUSES: readonly string[] = [
  'Accepted',
  'Superseded',
  'Deprecated',
  'Proposed',
];

/** One record on disk. */
export interface DecisionRecord {
  file: string;
  number: number;
  text: string;
}

/** Every `NNNN-*.md` record, in number order. */
export function decisionRecords(): DecisionRecord[] {
  return readdirSync(DECISIONS)
    .filter((file) => /^\d{4}-.+\.md$/.test(file))
    .map((file) => ({
      file,
      number: Number(file.slice(0, 4)),
      text: readFileSync(join(DECISIONS, file), 'utf8'),
    }))
    .sort((a, b) => a.number - b.number);
}

/** The record files the README index links. */
export function indexedRecordFiles(): string[] {
  const index = readFileSync(join(DECISIONS, 'README.md'), 'utf8');
  return [...index.matchAll(/\((\d{4}-[^)]+\.md)\)/g)].map((match) => match[1]);
}
