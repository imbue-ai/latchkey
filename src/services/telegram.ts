import { createInterface } from 'readline';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials } from '../apiCredentials.js';
import { extractUrlFromCurlArguments } from '../curl.js';
import { EncryptedStorage } from '../encryptedStorage.js';
import {
  type BrowserLaunchOptions,
  withTempBrowserContext,
} from '../playwrightUtils.js';
import {
  LoginFailedError,
  NoCurlCredentialsNotSupportedError,
  Service,
  ServiceSession,
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
  indexedDBKeyNames: string[];
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
 * Wait for the user to press Enter in the terminal.
 */
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Exploration session that captures all auth-related data from web.telegram.org.
 *
 * Overrides login() to use a manual "press Enter" flow instead of auto-detection,
 * since the Telegram Web A SPA loads its full bundle before login (making
 * response-based login detection unreliable).
 */
class TelegramExplorationSession extends ServiceSession {
  private capturedRequests: CapturedRequest[] = [];

  onResponse(response: Response): void {
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
  }

  protected isLoginComplete(): boolean {
    // Not used -- we override login() entirely.
    return false;
  }

  protected finalizeCredentials(): Promise<ApiCredentials | null> {
    // Not used -- we override login() entirely.
    return Promise.resolve(null);
  }

  override async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {}
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
      const page = await context.newPage();

      // Capture all network responses
      context.on('response', (response) => {
        this.onResponse(response);
      });

      // Navigate to Telegram Web
      await page.goto(this.service.loginUrl);

      console.log('\n=== Telegram Login ===');
      console.log('A browser window has opened to web.telegram.org.');
      console.log('Please log in with your phone number and verification code.');
      console.log('Once you see your chat list, come back here.\n');

      await waitForEnter('Press Enter after you have logged in... ');

      console.log('\nCapturing browser data...');

      // Wait for any in-flight requests to settle
      await page.waitForTimeout(2000);

      // Extract localStorage (string expression evaluated in browser context)
      const localStorageData: Record<string, string> = await page.evaluate(
        `(() => {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              const value = localStorage.getItem(key);
              if (value) {
                data[key] = value.length > 2000 ? value.slice(0, 2000) + '...[truncated]' : value;
              }
            }
          }
          return data;
        })()`
      );

      // Extract sessionStorage
      const sessionStorageData: Record<string, string> = await page.evaluate(
        `(() => {
          const data = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) {
              const value = sessionStorage.getItem(key);
              if (value) {
                data[key] = value.length > 2000 ? value.slice(0, 2000) + '...[truncated]' : value;
              }
            }
          }
          return data;
        })()`
      );

      // Try to list IndexedDB database names and object store names
      const indexedDBKeyNames: string[] = await page.evaluate(
        `(async () => {
          try {
            const databases = await indexedDB.databases();
            const results = [];
            for (const db of databases) {
              results.push('DB: ' + db.name + ' (v' + db.version + ')');
              try {
                const openReq = indexedDB.open(db.name, db.version);
                const opened = await new Promise((resolve, reject) => {
                  openReq.onsuccess = () => resolve(openReq.result);
                  openReq.onerror = () => reject(openReq.error);
                });
                const storeNames = Array.from(opened.objectStoreNames);
                for (const storeName of storeNames) {
                  results.push('  Store: ' + storeName);
                  try {
                    const tx = opened.transaction(storeName, 'readonly');
                    const store = tx.objectStore(storeName);
                    const countReq = store.count();
                    const count = await new Promise((resolve, reject) => {
                      countReq.onsuccess = () => resolve(countReq.result);
                      countReq.onerror = () => reject(countReq.error);
                    });
                    results.push('    count: ' + count);
                    // Sample first 3 keys
                    const keysReq = store.getAllKeys();
                    const keys = await new Promise((resolve, reject) => {
                      keysReq.onsuccess = () => resolve(keysReq.result);
                      keysReq.onerror = () => reject(keysReq.error);
                    });
                    const sampleKeys = keys.slice(0, 5).map(k => String(k));
                    results.push('    sample keys: ' + sampleKeys.join(', '));
                  } catch (e) {
                    results.push('    error reading store: ' + e);
                  }
                }
                opened.close();
              } catch (e) {
                results.push('  error opening: ' + e);
              }
            }
            return results;
          } catch (e) {
            return ['indexedDB.databases() not supported or error: ' + e];
          }
        })()`
      );

      // Extract cookies
      const cookies = await context.cookies();

      const dump: TelegramBrowserDump = {
        localStorage: localStorageData,
        sessionStorage: sessionStorageData,
        indexedDBKeyNames,
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
      console.log(`\nLocalStorage keys (${Object.keys(localStorageData).length}):`);
      for (const key of Object.keys(localStorageData)) {
        const val = localStorageData[key] ?? '';
        console.log(`  ${key}: ${val.slice(0, 80)}${val.length > 80 ? '...' : ''}`);
      }
      console.log(`\nSessionStorage keys (${Object.keys(sessionStorageData).length}):`);
      for (const key of Object.keys(sessionStorageData)) {
        const val = sessionStorageData[key] ?? '';
        console.log(`  ${key}: ${val.slice(0, 80)}${val.length > 80 ? '...' : ''}`);
      }
      console.log(`\nIndexedDB:`);
      for (const line of indexedDBKeyNames) {
        console.log(`  ${line}`);
      }
      console.log(
        `\nTelegram cookies: ${cookies
          .filter((c) => c.domain.includes('telegram'))
          .map((c) => c.name)
          .join(', ') || '(none)'}`
      );
      console.log(`Captured requests: ${this.capturedRequests.length}`);
      console.log(`\nInspect the dump file for full details.`);

      // Return a LoginFailedError for now -- this is exploration only.
      throw new LoginFailedError(
        'Exploration complete. Data dumped to ' + dumpPath + '. No credentials extracted yet.'
      );
    });
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
