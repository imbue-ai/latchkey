import { Service } from './core/base.js';

export class Coolify extends Service {
  readonly name = 'coolify';
  readonly displayName = 'Coolify';
  readonly baseApiUrls = ['https://app.coolify.io/api/'] as const;
  readonly loginUrl = 'https://app.coolify.io/login';
  readonly info = 'https://coolify.io/docs/llms.txt';

  readonly credentialCheckCurlArguments = ['https://app.coolify.io/api/v1/version'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }
}

export const COOLIFY = new Coolify();
