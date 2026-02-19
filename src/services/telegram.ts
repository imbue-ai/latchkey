import { Service } from './base.js';

export class Telegram extends Service {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';
  readonly baseApiUrls = ['https://api.telegram.org/'] as const;
  readonly loginUrl = 'https://web.telegram.org/';
  readonly info =
    'https://core.telegram.org/bots/api. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set telegram -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = ['https://api.telegram.org/bot{token}/getMe'] as const;

  override checkApiCredentials(): never {
    throw new TelegramCredentialCheckError(
      'Telegram Bot API tokens are embedded in the URL path, not in headers. ' +
        'Credential checking is not supported for Telegram.'
    );
  }
}

class TelegramCredentialCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramCredentialCheckError';
  }
}

export const TELEGRAM = new Telegram();
