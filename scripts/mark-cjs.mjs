/**
 * Mark dist/cjs as CommonJS. The package root is "type": "module", so without
 * this file Node would read the CommonJS build as ES modules and fail on its
 * first `require`, and TypeScript would read its declarations as ESM.
 */
import { writeFileSync } from 'node:fs';

writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' })}\n`);
