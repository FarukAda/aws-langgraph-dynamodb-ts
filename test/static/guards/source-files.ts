import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path to the source root scanned by every static guard. */
export const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src');

/**
 * Recursively list every `.ts` source file under {@link SRC_ROOT}, excluding
 * `.d.ts` declaration files. Returns absolute paths.
 */
export function listSourceFiles(root: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}
