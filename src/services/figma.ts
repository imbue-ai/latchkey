import { Service } from './core/base.js';

export class Figma extends Service {
  readonly name = 'figma';
  readonly displayName = 'Figma';
  readonly baseApiUrls = ['https://api.figma.com/'] as const;
  readonly loginUrl = 'https://www.figma.com/login';
  readonly info = 'https://www.figma.com/developers/api.';

  readonly credentialCheckCurlArguments = ['https://api.figma.com/v1/me'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }
}

export const FIGMA = new Figma();
