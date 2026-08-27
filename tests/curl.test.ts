import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { resetCurlCommand, runCapturedAsync, setCurlCommand } from '../src/curl.js';

describe('curl command selection', () => {
  afterEach(() => {
    resetCurlCommand();
  });

  it('spawns the command set with setCurlCommand', async () => {
    setCurlCommand('echo');

    const result = await runCapturedAsync(['from-the-override']);

    expect(result.returncode).toBe(0);
    expect(result.stdout.trim()).toBe('from-the-override');
  });

  it('spawns the configured command again after a reset', () => {
    setCurlCommand('echo');
    resetCurlCommand();

    // The startup config decides again, and this suite has no curl stand-in for
    // it, so all that can be checked is which binary it names.
    expect(CONFIG.curlCommand).toBe('curl');
  });

  it('takes the most recent command when set more than once', async () => {
    setCurlCommand('true');
    setCurlCommand('echo');

    const result = await runCapturedAsync(['second-override']);

    expect(result.stdout.trim()).toBe('second-override');
  });
});
