import { Service } from './base.js';

export class Whatsapp extends Service {
  readonly name = 'whatsapp';
  readonly displayName = 'WhatsApp';
  readonly baseApiUrls = ['https://graph.facebook.com/'] as const;
  readonly loginUrl = 'https://business.facebook.com/';
  readonly info =
    'https://developers.facebook.com/docs/whatsapp/cloud-api/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set whatsapp -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Obtain an access token from the Meta Developer Portal at https://developers.facebook.com/.';

  readonly credentialCheckCurlArguments = ['https://graph.facebook.com/v21.0/me'] as const;
}

export const WHATSAPP = new Whatsapp();
