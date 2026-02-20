import { z } from 'zod';
import { ApiCredentialStatus, type ApiCredentials } from '../apiCredentials.js';
import { extractUrlFromCurlArguments, runCaptured } from '../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from './base.js';

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

export class Telegram extends Service {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';
  readonly baseApiUrls = [BASE_API_URL] as const;
  readonly loginUrl = 'https://web.telegram.org/';
  readonly info =
    'https://core.telegram.org/bots/api. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set-nocurl telegram <bot-token>` to add credentials.';

  readonly credentialCheckCurlArguments = [`${BASE_API_URL}getMe`] as const;

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 1 || arguments_[0] === undefined) {
      throw new TelegramCredentialError(
        'Expected exactly one argument: the bot token.\n' +
          'Example: latchkey auth set-nocurl telegram 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
      );
    }
    const token = arguments_[0];
    if (!token.includes(':')) {
      throw new TelegramCredentialError(
        "The provided token doesn't look like a Telegram bot token (expected format: <id>:<hash>).\n" +
          'Example: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
      );
    }
    return new TelegramBotCredentials(token);
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    const allCurlArgs = apiCredentials.injectIntoCurlCall([
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      ...this.credentialCheckCurlArguments,
    ]);

    const result = runCaptured(allCurlArgs, 10);

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
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
