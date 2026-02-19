import { Service } from './base.js';

export class Zoom extends Service {
  readonly name = 'zoom';
  readonly displayName = 'Zoom';
  readonly baseApiUrls = ['https://api.zoom.us/v2/'] as const;
  readonly loginUrl = 'https://zoom.us/signin';
  readonly info =
    'https://developers.zoom.us/docs/api/. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set zoom -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = ['https://api.zoom.us/v2/users/me'] as const;
}

export const ZOOM = new Zoom();
