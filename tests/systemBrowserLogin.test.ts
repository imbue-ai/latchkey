/**
 * Tests for logging in with the system browser: the command that opens it,
 * the browser abstraction the loopback OAuth logins share, and which sessions
 * declare that they can use it.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { LoginCancelledError } from '../src/services/core/base.js';
import { withOAuthLoginBrowser } from '../src/services/core/oauthLoginBrowser.js';
import { McpLoginFlow } from '../src/services/core/loginFlows/mcp.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { FASTMAIL } from '../src/services/fastmail.js';
import { GOOGLE_GMAIL } from '../src/services/google/gmail.js';
import { NOTION_MCP } from '../src/services/notion-mcp.js';
import { RAMP } from '../src/services/ramp.js';
import { SLACK } from '../src/services/slack.js';
import { GITHUB } from '../src/services/github.js';
import * as playwrightUtils from '../src/playwrightUtils.js';
import * as systemBrowser from '../src/systemBrowser.js';
import {
  buildSystemBrowserCommand,
  openInSystemBrowser,
  SystemBrowserOpenError,
} from '../src/systemBrowser.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: spawnMock };
});

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';
const URL_WITH_QUERY = 'https://auth.example.com/authorize?client_id=abc&state=xyz';

class FakeChildProcess extends EventEmitter {
  readonly unref = vi.fn();
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe('buildSystemBrowserCommand', () => {
  it('uses xdg-open on Linux', () => {
    expect(buildSystemBrowserCommand(URL_WITH_QUERY, 'linux')).toEqual({
      command: 'xdg-open',
      args: [URL_WITH_QUERY],
      verbatimArguments: false,
    });
  });

  it('uses open on macOS', () => {
    expect(buildSystemBrowserCommand(URL_WITH_QUERY, 'darwin')).toEqual({
      command: 'open',
      args: [URL_WITH_QUERY],
      verbatimArguments: false,
    });
  });

  it('quotes the URL for the cmd.exe start built-in on Windows', () => {
    expect(buildSystemBrowserCommand(URL_WITH_QUERY, 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'start', '""', `"${URL_WITH_QUERY}"`],
      verbatimArguments: true,
    });
  });
});

describe('openInSystemBrowser', () => {
  it('resolves once the opener is running and lets go of it', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await openInSystemBrowser(URL_WITH_QUERY);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string },
    ];
    expect(args).toContain(URL_WITH_QUERY);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('reports an opener that cannot be started as a login failure', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn xdg-open ENOENT')));
      return child;
    });

    await expect(openInSystemBrowser(URL_WITH_QUERY)).rejects.toThrow(SystemBrowserOpenError);
    await expect(openInSystemBrowser(URL_WITH_QUERY)).rejects.toThrow('ENOENT');
  });
});

describe('withOAuthLoginBrowser', () => {
  const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);

  function stubPlaywrightBrowser() {
    const fakePage = {
      goto: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    };
    const fakeContext = {
      newPage: vi.fn().mockResolvedValue(fakePage),
      on: vi.fn(),
      off: vi.fn(),
    };
    const withTempBrowserContext = vi
      .spyOn(playwrightUtils, 'withTempBrowserContext')
      .mockImplementation((_storage, _options, callback) =>
        callback({
          browser: {},
          context: fakeContext,
        } as unknown as playwrightUtils.BrowserWithContext)
      );
    return { fakePage, fakeContext, withTempBrowserContext };
  }

  describe('with the system browser', () => {
    it('opens the URL in the system browser and leaves Playwright alone', async () => {
      const openInSystemBrowserSpy = vi
        .spyOn(systemBrowser, 'openInSystemBrowser')
        .mockResolvedValue(undefined);
      const { withTempBrowserContext } = stubPlaywrightBrowser();

      const result = await withOAuthLoginBrowser(
        encryptedStorage,
        {},
        { systemBrowser: true },
        async (browser) => {
          await browser.open(URL_WITH_QUERY);
          return 'done';
        }
      );

      expect(result).toBe('done');
      expect(openInSystemBrowserSpy).toHaveBeenCalledWith(URL_WITH_QUERY);
      expect(withTempBrowserContext).not.toHaveBeenCalled();
    });

    it('never signals a closed browser', async () => {
      vi.spyOn(systemBrowser, 'openInSystemBrowser').mockResolvedValue(undefined);

      const closeSignal = await withOAuthLoginBrowser(
        encryptedStorage,
        {},
        { systemBrowser: true },
        (browser) => Promise.resolve(browser.closeSignal)
      );

      expect(closeSignal.aborted).toBe(false);
    });
  });

  describe("with Latchkey's own browser", () => {
    it('navigates a Playwright page to the URL and closes it afterwards', async () => {
      const { fakePage } = stubPlaywrightBrowser();
      const openInSystemBrowserSpy = vi.spyOn(systemBrowser, 'openInSystemBrowser');

      const result = await withOAuthLoginBrowser(encryptedStorage, {}, {}, async (browser) => {
        await browser.open(URL_WITH_QUERY);
        expect(fakePage.close).not.toHaveBeenCalled();
        return 'done';
      });

      expect(result).toBe('done');
      expect(fakePage.goto).toHaveBeenCalledWith(URL_WITH_QUERY, { waitUntil: 'domcontentloaded' });
      expect(fakePage.close).toHaveBeenCalledTimes(1);
      expect(openInSystemBrowserSpy).not.toHaveBeenCalled();
    });

    it('signals a closed page and stops listening afterwards', async () => {
      const { fakePage, fakeContext } = stubPlaywrightBrowser();

      const closeSignal = await withOAuthLoginBrowser(encryptedStorage, {}, {}, (browser) => {
        const [, closeHandler] = fakePage.on.mock.calls.find(([event]) => event === 'close') as [
          string,
          () => void,
        ];
        closeHandler();
        return Promise.resolve(browser.closeSignal);
      });

      expect(closeSignal.aborted).toBe(true);
      expect(fakePage.off).toHaveBeenCalledWith('close', expect.any(Function));
      expect(fakeContext.off).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('reports a browser closed mid-login as a cancelled login', async () => {
      const { fakePage } = stubPlaywrightBrowser();
      fakePage.goto.mockRejectedValue(new Error('Target page, context or browser has been closed'));

      await expect(
        withOAuthLoginBrowser(encryptedStorage, {}, {}, (browser) => browser.open(URL_WITH_QUERY))
      ).rejects.toThrow(LoginCancelledError);
    });
  });
});

describe('ServiceSession.supportsSystemBrowser', () => {
  it.each([
    ['a Google service', GOOGLE_GMAIL],
    ['a remote MCP service', NOTION_MCP],
    ['Fastmail', FASTMAIL],
    ['Ramp', RAMP],
  ])('is declared by %s, whose login is a loopback OAuth redirect', (_name, service) => {
    expect(service.getSession('Latchkey-').supportsSystemBrowser).toBe(true);
  });

  it('is declared by a service registered with the mcp login flow', () => {
    const flow = new McpLoginFlow({
      mcpEndpoint: 'https://mcp.example.com/mcp',
      tokenEndpoint: 'https://auth.example.com/token',
      registrationEndpoint: 'https://auth.example.com/register',
    });
    const service = new RegisteredService('my-mcp', flow.baseApiUrl, {
      loginFlow: flow,
      loginUrl: 'https://auth.example.com/authorize',
    });

    expect(service.getSession?.('Latchkey-').supportsSystemBrowser).toBe(true);
  });

  it.each([
    ['Slack', SLACK],
    ['GitHub', GITHUB],
  ])('is not declared by %s, whose login reads what the browser sees', (_name, service) => {
    expect(service.getSession('Latchkey-').supportsSystemBrowser).toBe(false);
  });
});
