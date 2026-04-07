import { createInterface } from 'readline';
import type { Response } from 'playwright';
import { z } from 'zod';
import { ApiCredentialStatus, type ApiCredentials } from '../apiCredentials.js';
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

// -------------------------------------------------------------------
// Credential type: Telegram Bot (for Bot API via curl)
// -------------------------------------------------------------------

export const TelegramBotCredentialsSchema = z.object({
  objectType: z.literal('telegramBot'),
  token: z.string(),
});

export type TelegramBotCredentialsData = z.infer<typeof TelegramBotCredentialsSchema>;

/**
 * Telegram Bot API credentials.
 * The bot token is embedded in the URL path as specified by the Telegram Bot API:
 * https://api.telegram.org/bot<token>/METHOD_NAME
 */
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

// -------------------------------------------------------------------
// Credential type: Telegram User (MTProto auth_key from browser login)
// -------------------------------------------------------------------

export const TelegramUserCredentialsSchema = z.object({
  objectType: z.literal('telegramUser'),
  dcId: z.number(),
  authKeyHex: z.string(),
  userId: z.string(),
  firstName: z.string(),
});

export type TelegramUserCredentialsData = z.infer<typeof TelegramUserCredentialsSchema>;

/**
 * Telegram user session credentials extracted from web.telegram.org.
 *
 * These store the MTProto auth_key, which is the core authentication secret
 * for the Telegram user API. This is NOT usable via curl (MTProto is a binary
 * protocol over TCP/WebSocket), but can be used with libraries like Telethon
 * to programmatically interact with Telegram as the user.
 */
export class TelegramUserCredentials implements ApiCredentials {
  readonly objectType = 'telegramUser' as const;
  readonly dcId: number;
  readonly authKeyHex: string;
  readonly userId: string;
  readonly firstName: string;

  constructor(dcId: number, authKeyHex: string, userId: string, firstName: string) {
    this.dcId = dcId;
    this.authKeyHex = authKeyHex;
    this.userId = userId;
    this.firstName = firstName;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    // User credentials cannot be injected into curl calls.
    // The MTProto protocol uses a binary format over TCP, not HTTP.
    // Use a library like Telethon with the stored auth_key instead.
    return curlArguments;
  }

  isExpired(): boolean | undefined {
    // MTProto auth keys do not expire, but they can be revoked by the user.
    return undefined;
  }

  toJSON(): TelegramUserCredentialsData {
    return {
      objectType: this.objectType,
      dcId: this.dcId,
      authKeyHex: this.authKeyHex,
      userId: this.userId,
      firstName: this.firstName,
    };
  }

  static fromJSON(data: TelegramUserCredentialsData): TelegramUserCredentials {
    return new TelegramUserCredentials(data.dcId, data.authKeyHex, data.userId, data.firstName);
  }
}

// -------------------------------------------------------------------
// Browser login session
// -------------------------------------------------------------------

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
 * Browser login session that extracts MTProto auth credentials from
 * web.telegram.org's localStorage after the user logs in.
 *
 * The Telegram Web A client stores the MTProto auth_key in localStorage
 * under keys like `dc3_auth_key`. This key, combined with the data center ID,
 * is sufficient to establish an authenticated MTProto session with libraries
 * like Telethon.
 */
class TelegramBrowserSession extends ServiceSession {
  onResponse(_response: Response): void {
    // We don't need to intercept responses -- credentials are in localStorage.
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

      await page.goto(this.service.loginUrl);

      console.log('\n=== Telegram Login ===');
      console.log('A browser window has opened to web.telegram.org.');
      console.log('Please log in with your phone number and verification code.');
      console.log('Once you see your chat list, come back here.\n');

      await waitForEnter('Press Enter after you have logged in... ');

      // Extract auth data from localStorage
      const authData: { dc: string; userAuth: string } | null = await page.evaluate(
        `(() => {
          const dc = localStorage.getItem('dc');
          const userAuth = localStorage.getItem('user_auth');
          if (!dc || !userAuth) return null;
          return { dc, userAuth };
        })()`
      );

      if (!authData) {
        throw new LoginFailedError(
          'Could not find Telegram auth data in localStorage. ' +
            'Make sure you are fully logged in (you should see your chat list).'
        );
      }

      const dcId = parseInt(authData.dc, 10);
      const userAuth = JSON.parse(authData.userAuth) as { dcID: number; id: string };

      // Get the auth_key for the active DC (no truncation -- we need the full key)
      const dcKeyName = `dc${String(dcId)}_auth_key`;
      const authKeyRaw: string | null = await page.evaluate(
        `localStorage.getItem('${dcKeyName}')`
      );

      if (!authKeyRaw) {
        throw new LoginFailedError(
          `Could not find auth key for DC ${String(dcId)} in localStorage.`
        );
      }

      // The auth_key value is JSON-encoded (wrapped in extra quotes)
      const authKeyHex = authKeyRaw.startsWith('"')
        ? JSON.parse(authKeyRaw) as string
        : authKeyRaw;

      if (authKeyHex.length !== 512) {
        throw new LoginFailedError(
          `Auth key has unexpected length: ${String(authKeyHex.length)} hex chars (expected 512).`
        );
      }

      // Get user info from the account data
      const accountData: string | null = await page.evaluate(
        `localStorage.getItem('account1')`
      );
      let firstName = '';
      if (accountData) {
        try {
          const parsed = JSON.parse(accountData) as { firstName?: string };
          firstName = parsed.firstName ?? '';
        } catch {
          // Ignore parse errors
        }
      }

      const credentials = new TelegramUserCredentials(
        dcId,
        authKeyHex,
        userAuth.id,
        firstName
      );

      console.log(`\nExtracted credentials for user ${firstName} (id=${userAuth.id}, DC=${String(dcId)}).`);

      return credentials;
    });
  }
}

// -------------------------------------------------------------------
// Service definition
// -------------------------------------------------------------------

export class Telegram extends Service {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';
  readonly baseApiUrls = [BASE_API_URL] as const;
  readonly loginUrl = 'https://web.telegram.org/a/';
  readonly info =
    'https://core.telegram.org/bots/api. ' +
    'Browser login extracts user credentials (MTProto auth_key) for use with Telethon. ' +
    'set-nocurl stores a bot token for use with the Bot API via curl.';

  readonly credentialCheckCurlArguments = [`${BASE_API_URL}getMe`] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <bot-token>`;
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (apiCredentials instanceof TelegramUserCredentials) {
      // User credentials can't be checked via curl. The auth_key is valid
      // unless it has been explicitly revoked by the user.
      return ApiCredentialStatus.Unknown;
    }
    return super.checkApiCredentials(apiCredentials);
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

  override getSession(): TelegramBrowserSession {
    return new TelegramBrowserSession(this);
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
