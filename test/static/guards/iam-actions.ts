import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { listSourceFiles, SRC_ROOT } from './source-files';

/**
 * The IAM actions each DocumentClient method needs. A transaction is
 * authorised by the item actions of the operations it carries, never by a
 * `TransactWriteItems` action, so `transactWrite` maps to the three item
 * actions the library puts in transactions.
 */
const ACTIONS_BY_METHOD: Record<string, readonly string[]> = {
  get: ['dynamodb:GetItem'],
  put: ['dynamodb:PutItem'],
  update: ['dynamodb:UpdateItem'],
  delete: ['dynamodb:DeleteItem'],
  query: ['dynamodb:Query'],
  scan: ['dynamodb:Scan'],
  batchWrite: ['dynamodb:BatchWriteItem'],
  batchGet: ['dynamodb:BatchGetItem'],
  transactWrite: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
  /** The S3 client: its commands are mapped separately. */
  send: [],
  destroy: [],
};

/** The IAM action each S3 command the library constructs needs. */
const ACTION_BY_S3_COMMAND: Record<string, string> = {
  PutObjectCommand: 's3:PutObject',
  GetObjectCommand: 's3:GetObject',
  DeleteObjectsCommand: 's3:DeleteObject',
  GetBucketLifecycleConfigurationCommand: 's3:GetLifecycleConfiguration',
  PutBucketLifecycleConfigurationCommand: 's3:PutLifecycleConfiguration',
};

/**
 * The IAM actions one source file needs, from its `client.<method>(` calls and
 * the S3 commands it constructs. An unmapped method or command throws, so a
 * new call site cannot slip past the README policy unnoticed.
 */
export function actionsUsedBy(source: string): string[] {
  const actions = new Set<string>();
  for (const [, method] of source.matchAll(/\bclient\.(\w+)\(/g)) {
    const mapped = ACTIONS_BY_METHOD[method];
    if (mapped === undefined) throw new Error(`unmapped DocumentClient method: ${method}`);
    for (const action of mapped) actions.add(action);
  }
  for (const [, command] of source.matchAll(/new (\w+Command)\(/g)) {
    const mapped = ACTION_BY_S3_COMMAND[command];
    if (mapped === undefined) throw new Error(`unmapped S3 command: ${command}`);
    actions.add(mapped);
  }
  return [...actions].sort();
}

/** Every DynamoDB and S3 action the library needs at runtime, from all of `src`. */
export function usedActions(): string[] {
  const actions = new Set<string>();
  for (const file of listSourceFiles()) {
    for (const action of actionsUsedBy(readFileSync(file, 'utf8'))) actions.add(action);
  }
  return [...actions].sort();
}

/** The DynamoDB and S3 actions the README's IAM section grants, across all of its policy blocks. */
export function documentedActions(readme: string): string[] {
  const start = readme.indexOf('## IAM permissions');
  if (start < 0) throw new Error('README has no IAM permissions section');
  const rest = readme.slice(start + 1);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const actions = new Set<string>();
  /** Only the strings inside an "Action" array count: condition keys such as dynamodb:LeadingKeys are not grants. */
  for (const [, block] of section.matchAll(/"Action":\s*\[([^\]]*)\]/g)) {
    for (const [, action] of block.matchAll(/"((?:dynamodb|s3):[A-Za-z]+)"/g)) actions.add(action);
  }
  return [...actions].sort();
}

/** The README at the repository root. */
export function readReadme(): string {
  return readFileSync(resolve(SRC_ROOT, '..', 'README.md'), 'utf8');
}
