/**
 * Package version extraction.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ../package.json works from src/, ../../package.json works from dist/src/
let version: string;
try {
  version = (require('../package.json') as { version: string }).version;
} catch {
  version = (require('../../package.json') as { version: string }).version;
}

export const VERSION = version;
