/**
 * Tests for the wait that the browser login phase of a service session does,
 * with the browser faked: what counts as the login still going, and what
 * counts as the user having given up.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Page, Response } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import {
  LoginCancelledError,
  Service,
  SimpleServiceSession,
} from '../src/services/core/base.js';
import * as playwrightUtils from '../src/playwrightUtils.js';

const LOGIN_URL = 'https://example.com/login';

/** A credential that is only ever compared by identity. */
const CAPTURED_CREDENTIALS = { objectType: 'fake' } as unknown as ApiCredentials;

class FakeService extends Service {
  readonly name = 'fake';
  readonly displayName = 'Fake';
  readonly baseApiUrls = ['https://api.example.com/'] as const;
  readonly loginUrl = LOGIN_URL;
  readonly info = '';
  readonly credentialCheckCurlArguments = [] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName}`;
  }

  override getSession(appNamePrefix: string): FakeSession {
    return new FakeSession(this, appNamePrefix);
  }
}

/** Captures credentials from any response at all, and notes each poll it gets. */
class FakeSession extends SimpleServiceSession {
  readonly pagesWatched: Page[] = [];

  protected getApiCredentialsFromResponse(_response: Response): Promise<ApiCredentials | null> {
    return Promise.resolve(CAPTURED_CREDENTIALS);
  }

  override whileWaitingForLogin(page: Page): Promise<void> {
    this.pagesWatched.push(page);
    return Promise.resolve();
  }
}

interface FakePage {
  readonly page: Page;
  close(): void;
}

function fakePage(name: string, pages: Page[]): FakePage {
  let closed = false;
  const page = {
    name,
    isClosed: () => closed,
    goto: () => Promise.resolve(null),
    context: () => context,
  } as unknown as Page;
  const context = {
    pages: () => pages.filter((candidate) => candidate !== page || !closed),
    browser: () => ({ isConnected: () => true }),
    on: () => undefined,
  };
  pages.push(page);
  return {
    page,
    close: () => {
      closed = true;
    },
  };
}

/**
 * A browser that starts with one page. The session's wait loop sees whatever
 * `pages` holds at the time it looks.
 */
function fakeBrowser(): {
  pages: Page[];
  initial: FakePage;
  sendAnyResponse: () => Promise<void>;
  session: FakeSession;
} {
  const pages: Page[] = [];
  const initial = fakePage('initial', pages);
  let onResponse: ((response: Response) => void) | undefined;
  const context = {
    newPage: () => Promise.resolve(initial.page),
    on: (_event: string, listener: (response: Response) => void) => {
      onResponse = listener;
    },
    pages: () => initial.page.context().pages(),
    browser: () => ({ isConnected: () => true }),
  };
  vi.spyOn(playwrightUtils, 'withTempBrowserContext').mockImplementation(
    (_storage, _options, callback) =>
      callback({ browser: {}, context } as unknown as playwrightUtils.BrowserWithContext)
  );
  const session = new FakeService().getSession('latchkey');
  return {
    pages,
    initial,
    sendAnyResponse: async () => {
      onResponse?.({} as Response);
      // Let the listener's asynchronous extraction land.
      await Promise.resolve();
    },
    session,
  };
}

function startLogin(session: FakeSession): Promise<ApiCredentials> {
  return session
    .login({} as unknown as EncryptedStorage)
    .then((result) => result.credentials);
}

/** A little over one poll interval. */
function waitForAPoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waiting for the browser login', () => {
  it('completes from a response arriving while the login is going', async () => {
    const browser = fakeBrowser();
    const login = startLogin(browser.session);
    await waitForAPoll();
    await browser.sendAnyResponse();
    await expect(login).resolves.toBe(CAPTURED_CREDENTIALS);
  });

  // An SSO flow may open the signed-in app in a new tab and close the first one.
  it('carries on in another tab after the first one closed', async () => {
    const browser = fakeBrowser();
    const login = startLogin(browser.session);
    const otherTab = fakePage('other', browser.pages);
    browser.initial.close();
    await waitForAPoll();
    await browser.sendAnyResponse();
    await expect(login).resolves.toBe(CAPTURED_CREDENTIALS);
    expect(browser.session.pagesWatched.at(-1)).toBe(otherTab.page);
  });

  it('watches the first tab for as long as it is open', async () => {
    const browser = fakeBrowser();
    const login = startLogin(browser.session);
    fakePage('other', browser.pages);
    await waitForAPoll();
    await browser.sendAnyResponse();
    await login;
    expect(browser.session.pagesWatched.at(-1)).toBe(browser.initial.page);
  });

  it('is cancelled once no page is left', async () => {
    const browser = fakeBrowser();
    const login = startLogin(browser.session);
    browser.initial.close();
    await expect(login).rejects.toBeInstanceOf(LoginCancelledError);
  });
});
