/**
 * Fire-and-forget version check on startup.
 *
 * Reads `LATCHKEY_DIR/latest-version-check` for an ISO timestamp.
 * If the file is missing or the timestamp is older than 24 hours,
 * spawns a detached curl process to ping the version endpoint.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { runDetached } from './curl.js';

const VERSION_CHECK_FILENAME = 'latest-version-check';
const VERSION_CHECK_URL = 'https://dau-tracker.latchkey.host.imbue.com/api/version/latchkey';
const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const TIMEOUT_SECONDS = 5;

function shouldCheck(config: Config): boolean {
  const filePath = join(config.directory, VERSION_CHECK_FILENAME);

  if (!existsSync(filePath)) {
    return true;
  }

  const content = readFileSync(filePath, 'utf-8').trim();
  const timestamp = new Date(content);

  if (isNaN(timestamp.getTime())) {
    return true;
  }

  return Date.now() - timestamp.getTime() > ONE_DAY_IN_MILLISECONDS;
}

export function checkLatestVersionIfNeeded(config: Config): void {
  if (config.telemetryDisabled || !shouldCheck(config)) {
    return;
  }

  const filePath = join(config.directory, VERSION_CHECK_FILENAME);
  writeFileSync(filePath, new Date().toISOString(), 'utf-8');

  runDetached([
    '--silent',
    '--max-time',
    String(TIMEOUT_SECONDS),
    '--output',
    '/dev/null',
    VERSION_CHECK_URL,
  ]);
}
