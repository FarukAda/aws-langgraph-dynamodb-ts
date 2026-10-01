import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { decisionRecords } from './decision-records';
import { listErrorCodeMembers } from './error-codes';
import { evidenceClaims } from './evidence';
import { jobBodies } from './release-gate';
import { SRC_ROOT } from './source-files';

const REPO_ROOT = resolve(SRC_ROOT, '..');

const UNITS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS: readonly string[] = [
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

/** A number as prose writes it: digits, or a number word with its optional hyphenated unit. */
const NUMBER = String.raw`(\d+|[A-Za-z]+(?:-[a-z]+)?)`;

/**
 * The number a piece of prose states, or `undefined` for a word that is not
 * one: digits, or an English number word below one hundred in either case
 * (`29`, `nine`, `Twenty-nine`).
 */
export function numberOf(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const [head, unit] = text.toLowerCase().split('-');
  const small = UNITS.indexOf(head);
  if (small >= 0) return unit === undefined ? small : undefined;
  const tens = TENS.indexOf(head);
  if (tens < 0) return undefined;
  const base = (tens + 2) * 10;
  if (unit === undefined) return base;
  const ones = UNITS.indexOf(unit);
  return ones >= 1 && ones <= 9 ? base + ones : undefined;
}

/** One count a document states in prose, beside the number the repository holds. */
export interface StatedCount {
  /** The document and what it counts, for the failure message. */
  claim: string;
  /** What the prose says; `undefined` when the sentence carrying it is gone. */
  stated: number | undefined;
  actual: number;
}

/** The number `pattern` captures in `file`, read as {@link numberOf} reads it. */
function statedIn(file: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return match === null ? undefined : numberOf(match[1]);
}

/** How many files in `directory`, relative to the repository root, `keep` accepts. */
function countFiles(directory: string, keep: (name: string) => boolean): number {
  return readdirSync(resolve(REPO_ROOT, directory)).filter(keep).length;
}

/**
 * Every count the documentation states about the repository itself, paired
 * with what is actually there. Each is a sentence a reader takes on trust and
 * nothing else re-derives: a record, a claim or a job added later leaves the
 * number behind it.
 */
export function statedCounts(): StatedCount[] {
  const records = decisionRecords().length;
  const claims = evidenceClaims();
  const claimFiles = new Set(claims.map((claim) => claim.file)).size;
  const workflows = countFiles('.github/workflows', (name) => name.endsWith('.yml'));
  const count = (file: string, what: string, pattern: string, actual: number): StatedCount => ({
    claim: `${file}: ${what}`,
    stated: statedIn(file, new RegExp(pattern)),
    actual,
  });
  return [
    count('README.md', 'decision records', `${NUMBER} architecture decision records`, records),
    count('README.md', 'evidence claims', `${NUMBER} claims across`, claims.length),
    count('README.md', 'evidence files', `claims across ${NUMBER} files`, claimFiles),
    count(
      'README.md',
      'error codes',
      `The ${NUMBER} codes a \`DynamoDBLangGraphError\` can carry`,
      listErrorCodeMembers().length,
    ),
    count('docs/README.md', 'decision records', `${NUMBER} records of decisions`, records),
    count('docs/README.md', 'evidence claims', `${NUMBER} claims about DynamoDB`, claims.length),
    count('docs/README.md', 'evidence files', `across ${NUMBER} claim files`, claimFiles),
    count(
      'docs/README.md',
      'example scripts',
      `of the ${NUMBER} scripts`,
      countFiles('examples', (name) => /^live-.+\.mjs$/.test(name)),
    ),
    count(
      'CONTRIBUTING.md',
      'CI jobs',
      `as ${NUMBER} jobs`,
      Object.keys(jobBodies('ci.yml')).length,
    ),
    count(
      'CONTRIBUTING.md',
      'workflows beside CI',
      `${NUMBER} more workflows run beside it`,
      workflows - 1,
    ),
  ];
}
