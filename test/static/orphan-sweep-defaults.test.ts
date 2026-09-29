import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_S3_KEY_PREFIX } from '../../src/shared/codec/s3/config';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
} from '../../src/shared/dynamodb/client';
import { readReadme } from './guards/iam-actions';
import { SRC_ROOT } from './guards/source-files';

const SCRIPT_PATH = 'scripts/find-orphaned-payloads.mjs';
const scriptText = (): string => readFileSync(resolve(SRC_ROOT, '..', SCRIPT_PATH), 'utf8');

/** The literal an exported default is declared with, read from the script's text. */
function declaredDefault(name: string): string {
  const match = new RegExp(`^export const ${name} = (.+);$`, 'm').exec(scriptText());
  if (match === null) throw new Error(`${SCRIPT_PATH} declares no ${name}`);
  return match[1];
}

describe('the orphan sweep and the constants it mirrors', () => {
  it('sweeps the base prefix the adapters offload under by default', () => {
    expect(declaredDefault('DEFAULT_PREFIX')).toBe(`'${DEFAULT_S3_KEY_PREFIX}'`);
  });

  it('bounds a request and an idle socket as the adapters do', () => {
    expect(Number(declaredDefault('DEFAULT_REQUEST_TIMEOUT_MS').replaceAll('_', ''))).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(Number(declaredDefault('DEFAULT_SOCKET_TIMEOUT_MS').replaceAll('_', ''))).toBe(
      DEFAULT_SOCKET_TIMEOUT_MS,
    );
  });

  it('is named in the README by its repository path', () => {
    expect(readReadme()).toContain(SCRIPT_PATH);
  });
});
