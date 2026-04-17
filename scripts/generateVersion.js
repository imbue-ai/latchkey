#!/usr/bin/env node
/**
 * Generate src/version.ts from package.json.
 *
 * Running this at build time lets us bake the version into the source as a
 * plain string literal, so:
 *   - No runtime JSON import is needed (avoids the ExperimentalWarning that
 *     older Node 20.x / early 22.x versions print for JSON module imports).
 *   - Bun's --compile bundler does not need to resolve `package.json` at all,
 *     so the resulting single-file executable works without the file being
 *     embedded in the bundle.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(rootDirectory, 'package.json');
const versionFilePath = join(rootDirectory, 'src', 'version.ts');

const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const content = `// Auto-generated from package.json by scripts/generateVersion.js.
// Do not edit by hand; run \`node scripts/generateVersion.js\` to refresh.
export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(versionFilePath, content);
