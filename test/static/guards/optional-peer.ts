import * as ts from 'typescript';

import { SRC_ROOT } from './source-files';

/** The one optional peer: installed only by users who offload to S3. */
export const OPTIONAL_PEER = '@aws-sdk/client-s3';

/**
 * The modules whose declarations reach the public surface and therefore must
 * not depend on the optional peer: the offload configuration and the
 * structural client types it is expressed in. Every other file under
 * `shared/codec/s3/` is runtime-only and may use the real SDK types.
 */
const PUBLIC_S3_MODULES: readonly string[] = ['config.ts', 'client-types.ts'];

/** True when `source` imports the optional peer — statically, as a type, or dynamically. */
export function importsOptionalPeer(source: string): boolean {
  const info = ts.preProcessFile(source, true, true);
  return info.importedFiles.some((file) => file.fileName === OPTIONAL_PEER);
}

/** True when `path` is an S3 runtime module, the only kind allowed to import the optional peer. */
export function mayImportOptionalPeer(path: string): boolean {
  const relative = path.slice(SRC_ROOT.length).replace(/\\/g, '/');
  if (!relative.startsWith('/shared/codec/s3/')) return false;
  return !PUBLIC_S3_MODULES.includes(relative.slice('/shared/codec/s3/'.length));
}
