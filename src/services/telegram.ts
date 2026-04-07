import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrowserContext, Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials } from '../apiCredentials.js';
import { extractUrlFromCurlArguments } from '../curl.js';
import {
  BrowserFollowupServiceSession,
  NoCurlCredentialsNotSupportedError,
  Service,
} from './core/base.js';

const BASE_API_URL = 'https://api.telegram.org/';

/**
 * Telegram Bot API credentials.
 * The bot token is embedded in the URL path as specified by the Telegram Bot API:
 * https://api.telegram.org/bot<token>/METHOD_NAME
 */
export const TelegramBotCredentialsSchema = z.object({
  objectType: z.literal('telegramBot'),
  token: z.string(),
});

export type TelegramBotCredentialsData = z.infer<typeof TelegramBotCredentialsSchema>;

export class TelegramBotCredentials implements ApiCredentials {
  readonly objectType = 'telegramBot' as const;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (!url?.startsWith(BASE_API_URL)) {
      return curlArguments;
    }
    const pathAfterBase = url.slice(BASE_API_URL.length);
    const rewrittenUrl = `${BASE_API_URL}bot${this.token}/${pathAfterBase}`;
    return curlArguments.map((argument) => (argument === url ? rewrittenUrl : argument));
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): TelegramBotCredentialsData {
    return {
      objectType: this.objectType,
      token: this.token,
    };
  }

  static fromJSON(data: TelegramBotCredentialsData): TelegramBotCredentials {
    return new TelegramBotCredentials(data.token);
  }
}

/**
 * Captured data from a single network request/response during Telegram login.
 */
interface CapturedRequest {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBodySnippet: string;
}

/**
 * All data dumped from the browser after Telegram login.
 */
interface TelegramBrowserDump {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
  }>;
  capturedRequests: CapturedRequest[];
}

/**
 * Service session that captures auth data from web.telegram.org during login.
 *
 * This is a prototyping/exploration session: it monitors all network traffic,
 * then after the user logs in and reaches the main chat view, it dumps
 * localStorage, sessionStorage, cookies, and captured network requests
 * to a temp file for inspection.
 */
class TelegramExplorationSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;
  private capturedRequests: CapturedRequest[] = [];

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    const url = request.url();

    // Capture all telegram-related requests
    if (
      url.includes('telegram.org') ||
      url.includes('t.me') ||
      url.includes('core.telegram.org')
    ) {
      void (async () => {
        try {
          const requestHeaders = await request.allHeaders();
          const responseHeaders = response.headers();
          let responseBodySnippet = '';
          try {
            const body = await response.text();
            // Keep first 2000 chars to avoid huge dumps
            responseBodySnippet = body.slice(0, 2000);
          } catch {
            responseBodySnippet = '<could not read body>';
          }

          this.capturedRequests.push({
            url,
            method: request.method(),
            status: response.status(),
            requestHeaders,
            responseHeaders,
            responseBodySnippet,
          });
        } catch {
          // Ignore errors capturing request data
        }
      })();
    }

    // Detect login completion: look for requests to the main web app API
    // that indicate the user has successfully authenticated.
    // Telegram Web A uses its own MTProto-over-websocket, but also makes
    // HTTPS requests. We look for successful API calls that only happen
    // when logged in.
    if (
      url.includes('web.telegram.org') &&
      (url.includes('/k/') || url.includes('/a/')) &&
      response.status() === 200
    ) {
      // Check if this looks like the main app page (not the login page)
      void response
        .text()
        .then((text) => {
          // The main app page will have certain markers
          if (
            text.includes('tgme_page') ||
            text.includes('im_page_wrap') ||
            text.includes('chat-list') ||
            text.includes('messages-container') ||
            text.length > 50000 // Main app bundle is large
          ) {
            this.isLoggedIn = true;
          }
        })
        .catch(() => {
          // Ignore errors
        });
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(
    context: BrowserContext
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      console.log('No page found in context');
      return null;
    }

    // Wait a moment for any remaining requests to settle
    await page.waitForTimeout(3000);

    // Extract localStorage (runs in browser context)
    const localStorageData: Record<string, string> = await page.evaluate(
      `(() => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            const value = localStorage.getItem(key);
            if (value) {
              data[key] = value.length > 500 ? value.slice(0, 500) + '...[truncated]' : value;
            }
          }
        }
        return data;
      })()`
    );

    // Extract sessionStorage (runs in browser context)
    const sessionStorageData: Record<string, string> = await page.evaluate(
      `(() => {
        const data = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) {
            const value = sessionStorage.getItem(key);
            if (value) {
              data[key] = value.length > 500 ? value.slice(0, 500) + '...[truncated]' : value;
            }
          }
        }
        return data;
      })()`
    );

    // Extract cookies
    const cookies = await context.cookies();

    const dump: TelegramBrowserDump = {
      localStorage: localStorageData,
      sessionStorage: sessionStorageData,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value.length > 200 ? c.value.slice(0, 200) + '...' : c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })),
      capturedRequests: this.capturedRequests,
    };

    const dumpPath = join(tmpdir(), 'latchkey-telegram-dump.json');
    writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
    console.log(`\n=== Telegram browser data dumped to: ${dumpPath} ===`);
    console.log(`\nLocalStorage keys: ${Object.keys(localStorageData).join(', ')}`);
    console.log(`SessionStorage keys: ${Object.keys(sessionStorageData).join(', ')}`);
    console.log(`Cookies: ${cookies.map((c) => c.name).join(', ')}`);
    console.log(`Captured requests: ${this.capturedRequests.length}`);
    console.log(`\nInspect the dump file for full details.`);

    // For now, return null -- this is an exploration session.
    // Once we know what tokens to extract, we'll return real credentials.
    return null;
  }
}

export class Telegram extends Service {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';
  readonly baseApiUrls = [BASE_API_URL] as const;
  readonly loginUrl = 'https://web.telegram.org/a/';
  readonly info =
    'https://core.telegram.org/bots/api. ' +
    'The bot token is injected automatically into the URL path at runtime. ' +
    'Example: latchkey curl https://api.telegram.org/sendMessage -d chat_id=123 -d text=hello';

  readonly credentialCheckCurlArguments = [`${BASE_API_URL}getMe`] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <bot-token>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 1 || arguments_[0] === undefined) {
      throw new TelegramCredentialError(
        'Expected exactly one argument: the bot token.\n' +
          'Example: latchkey auth set-nocurl telegram <bot-token>'
      );
    }
    const token = arguments_[0];
    if (!token.includes(':')) {
      throw new TelegramCredentialError(
        "The provided token doesn't look like a Telegram bot token (expected format: <id>:<hash>).\n" +
          'Example: <bot-token>'
      );
    }
    return new TelegramBotCredentials(token);
  }

  override getSession(): TelegramExplorationSession {
    return new TelegramExplorationSession(this);
  }
}

class TelegramCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('telegram');
    this.message = message;
    this.name = 'TelegramCredentialError';
  }
}

export const TELEGRAM = new Telegram();
