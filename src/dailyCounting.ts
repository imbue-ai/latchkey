/**
 * Fire-and-forget daily count on startup.
 *
 * Reads `LATCHKEY_DIR/last-daily-count` for an ISO timestamp.
 * If the file is missing or the timestamp is older than 24 hours,
 * spawns a detached curl process to ping the counting endpoint.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { runDetached } from './curl.js';

const DAILY_COUNT_FILENAME = 'last-daily-count';
const COUNTING_URL = 'https://latchkey.goatcounter.com/count?p=/daily';
const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const TIMEOUT_SECONDS = 5;

function shouldCount(config: Config): boolean {
  const filePath = join(config.directory, DAILY_COUNT_FILENAME);

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

export function countDailyIfNeeded(config: Config): void {
  if (config.countingDisabled || !shouldCount(config)) {
    return;
  }

  const filePath = join(config.directory, DAILY_COUNT_FILENAME);
  writeFileSync(filePath, new Date().toISOString(), 'utf-8');

  runDetached([
    '--silent',
    '--max-time',
    String(TIMEOUT_SECONDS),
    '--output',
    '/dev/null',
    '-H',
    'User-Agent: Mozilla/5.0 (compatible)',
    COUNTING_URL,
  ]);
}
