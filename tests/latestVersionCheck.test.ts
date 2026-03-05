import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config } from '../src/config.js';
import { checkLatestVersionIfNeeded } from '../src/latestVersionCheck.js';
import { setDetachedSubprocessRunner, resetDetachedSubprocessRunner } from '../src/curl.js';

describe('checkLatestVersionIfNeeded', () => {
  let directory: string;
  let config: Config;
  let detachedCalls: readonly string[][];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-version-check-'));
    config = new Config(() => undefined);
    // Override directory via a new Config with custom env
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
    checkLatestVersionIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
    expect(detachedCalls[0]).toContain(
      'https://dau-tracker.latchkey.host.imbue.com/api/version/latchkey'
    );
    expect(detachedCalls[0]).toContain('--max-time');
    expect(detachedCalls[0]).toContain('5');
  });

  it('should write the current timestamp to the file after firing', () => {
    checkLatestVersionIfNeeded(config);

    const filePath = join(directory, 'latest-version-check');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8').trim();
    const timestamp = new Date(content);
    expect(isNaN(timestamp.getTime())).toBe(false);
    expect(Date.now() - timestamp.getTime()).toBeLessThan(5000);
  });

  it('should not fire a request when the file has a recent timestamp', () => {
    const filePath = join(directory, 'latest-version-check');
    writeFileSync(filePath, new Date().toISOString(), 'utf-8');

    checkLatestVersionIfNeeded(config);

    expect(detachedCalls).toHaveLength(0);
  });

  it('should fire a request when the timestamp is older than 24 hours', () => {
    const filePath = join(directory, 'latest-version-check');
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    writeFileSync(filePath, oldDate.toISOString(), 'utf-8');

    checkLatestVersionIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
  });

  it('should fire a request when the file contains invalid content', () => {
    const filePath = join(directory, 'latest-version-check');
    writeFileSync(filePath, 'not-a-date', 'utf-8');

    checkLatestVersionIfNeeded(config);

    expect(detachedCalls).toHaveLength(1);
  });

  it('should not fire a request when telemetry is disabled', () => {
    const telemetryDisabledConfig = new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return directory;
      if (name === 'LATCHKEY_DISABLE_TELEMETRY') return '1';
      return undefined;
    });

    checkLatestVersionIfNeeded(telemetryDisabledConfig);

    expect(detachedCalls).toHaveLength(0);
  });

  it('should not fire a request when the timestamp is exactly 23 hours old', () => {
    const filePath = join(directory, 'latest-version-check');
    const recentDate = new Date(Date.now() - 23 * 60 * 60 * 1000);
    writeFileSync(filePath, recentDate.toISOString(), 'utf-8');

    checkLatestVersionIfNeeded(config);

    expect(detachedCalls).toHaveLength(0);
  });
});
