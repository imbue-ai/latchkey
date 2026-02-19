import { ApiCredentials, ApiCredentialStatus, TelegramBotCredentials } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from './base.js';

export class Telegram extends Service {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';
  readonly baseApiUrls = ['https://api.telegram.org/'] as const;
  readonly loginUrl = 'https://web.telegram.org/';
  readonly info =
    'https://core.telegram.org/bots/api. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set-nocurl telegram <bot-token>` to add credentials.';

  readonly credentialCheckCurlArguments = ['https://api.telegram.org/getMe'] as const;

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
