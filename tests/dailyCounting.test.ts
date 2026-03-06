import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config } from '../src/config.js';
import { countDailyIfNeeded } from '../src/dailyCounting.js';
import { setDetachedSubprocessRunner, resetDetachedSubprocessRunner } from '../src/curl.js';

describe('countDailyIfNeeded', () => {
  let directory: string;
  let config: Config;
  let detachedCalls: readonly string[][];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-daily-count-'));
    config = new Config((name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined));

    detachedCalls = [];
    setDetachedSubprocessRunner((args) => {
      detachedCalls = [...detachedCalls, [...args]];
    });
  });

  afterEach(() => {
    resetDetachedSubprocessRunner();
    rmSync(directory, { recursive: true, force: true });
  });

  it('should fire a request when the file does not exist', () => {
    countDailyIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
    expect(detachedCalls[0]).toContain('https://latchkey.goatcounter.com/count?p=/daily');
    expect(detachedCalls[0]).toContain('--max-time');
    expect(detachedCalls[0]).toContain('5');
    expect(detachedCalls[0]).toContain('-H');
    expect(detachedCalls[0]).toContain('User-Agent: Mozilla/5.0 (compatible)');
  });

  it('should write the current timestamp to the file after firing', () => {
    countDailyIfNeeded(config);

    const filePath = join(directory, 'last-daily-count');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8').trim();
    const timestamp = new Date(content);
    expect(isNaN(timestamp.getTime())).toBe(false);
    expect(Date.now() - timestamp.getTime()).toBeLessThan(5000);
  });

  it('should not fire a request when the file has a recent timestamp', () => {
    const filePath = join(directory, 'last-daily-count');
    writeFileSync(filePath, new Date().toISOString(), 'utf-8');

    countDailyIfNeeded(config);

    expect(detachedCalls).toHaveLength(0);
  });

  it('should fire a request when the timestamp is older than 24 hours', () => {
    const filePath = join(directory, 'last-daily-count');
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    writeFileSync(filePath, oldDate.toISOString(), 'utf-8');

    countDailyIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
  });

  it('should fire a request when the file contains invalid content', () => {
    const filePath = join(directory, 'last-daily-count');
    writeFileSync(filePath, 'not-a-date', 'utf-8');

    countDailyIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
  });

  it('should not fire a request when counting is disabled', () => {
    const countingDisabledConfig = new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return directory;
      if (name === 'LATCHKEY_DISABLE_COUNTING') return '1';
      return undefined;
    });

    countDailyIfNeeded(countingDisabledConfig);

    expect(detachedCalls).toHaveLength(0);
  });

  it('should not fire a request when the timestamp is exactly 23 hours old', () => {
    const filePath = join(directory, 'last-daily-count');
    const recentDate = new Date(Date.now() - 23 * 60 * 60 * 1000);
    writeFileSync(filePath, recentDate.toISOString(), 'utf-8');

    countDailyIfNeeded(config);

    expect(detachedCalls).toHaveLength(0);
  });
});
