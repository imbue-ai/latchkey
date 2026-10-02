/**
 * Tests for what a browser followup session does once its automation fails:
 * offer the manual credential form, unless the failure is one the user could
 * not work around by hand.
 *
 * Browser-free: the context and page are stand-ins exposing only what the
 * failure handling touches, and the spinner is disabled so the only page ever
 * opened is the form's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { AuthorizationBearer, type ApiCredentials } from '../src/apiCredentials/base.js';
import {
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
  UnrecoverableLoginFailedError,
  type ManualCredentialForm,
} from '../src/services/core/base.js';
import { HUGGINGFACE } from '../src/services/huggingface.js';

class FailingFollowupSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApiToken;
  override readonly manualCredentialForm: ManualCredentialForm = {
    instructions: 'Create a token by hand.',
    fields: [{ name: 'token', label: 'Token' }],
    buildCredentials: (values) => new AuthorizationBearer(values.get('token')),
  };

  constructor(private readonly failure: Error) {
    super(HUGGINGFACE, 'latchkey');
  }

  onResponse(_response: Response): void {
    // The login phase is not exercised here.
  }

  protected isLoginComplete(): boolean {
    return true;
  }

  protected performBrowserFollowup(): Promise<ApiCredentials | null> {
    return Promise.reject(this.failure);
  }

  finalize(context: BrowserContext): Promise<ApiCredentials | null> {
    return this.finalizeCredentials({} as Browser, context);
  }
}

interface FakeBrowser {
  readonly context: BrowserContext;
  /** How many pages were opened, i.e. whether the form was shown. */
  readonly getOpenedPageCount: () => number;
  readonly closeBrowser: () => void;
}

function createFakeBrowser(): FakeBrowser {
  let openedPageCount = 0;
  const closeListeners: (() => void)[] = [];

  const page = {
    isClosed: () => false,
    bringToFront: () => Promise.resolve(),
    exposeFunction: () => Promise.resolve(),
    evaluate: () => Promise.resolve(undefined),
    on: (event: string, listener: () => void) => {
      if (event === 'close') {
        closeListeners.push(listener);
      }
    },
  } as unknown as Page;

  const context = {
    newPage: () => {
      openedPageCount += 1;
      return Promise.resolve(page);
    },
    on: () => undefined,
    browser: () => ({ on: () => undefined }),
  } as unknown as BrowserContext;

  return {
    context,
    getOpenedPageCount: () => openedPageCount,
    closeBrowser: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
  };
}

describe('browser followup failure recovery', () => {
  beforeEach(() => {
    vi.stubEnv('LATCHKEY_DISABLE_SPINNER', '1');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('offers the manual credential form after an ordinary failure', async () => {
    const browser = createFakeBrowser();
    const failure = new LoginFailedError('The token page changed.');
    const session = new FailingFollowupSession(failure);

    const finalization = session.finalize(browser.context);
    await vi.waitFor(() => {
      expect(browser.getOpenedPageCount()).toBe(1);
    });
    browser.closeBrowser();

    await expect(finalization).rejects.toBe(failure);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('reports an unrecoverable failure straight away, without the form', async () => {
    const browser = createFakeBrowser();
    const failure = new UnrecoverableLoginFailedError('Your user may not create apps.');
    const session = new FailingFollowupSession(failure);

    await expect(session.finalize(browser.context)).rejects.toBe(failure);
    expect(browser.getOpenedPageCount()).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});
