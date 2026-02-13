import { Service } from './base.js';

export class Figma extends Service {
  readonly name = 'figma';
  readonly displayName = 'Figma';
  readonly baseApiUrls = ['https://api.figma.com/'] as const;
  readonly loginUrl = 'https://www.figma.com/login';
  readonly info =
    'https://www.figma.com/developers/api. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set figma -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Create a personal access token at https://www.figma.com/developers/api#access-tokens.';

  readonly credentialCheckCurlArguments = ['https://api.figma.com/v1/me'] as const;
}

export const FIGMA = new Figma();
