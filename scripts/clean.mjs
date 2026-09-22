/**
 * Remove the build output directory before compilation so that stale modules
 * (files whose sources no longer exist) are not carried forward into dist/.
 */
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
