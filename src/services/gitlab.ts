import { Service } from './base.js';

export class Gitlab extends Service {
  readonly name = 'gitlab';
  readonly displayName = 'GitLab';
  readonly baseApiUrls = ['https://gitlab.com/api/'] as const;
  readonly loginUrl = 'https://gitlab.com/users/sign_in';
  readonly info = 'https://docs.gitlab.com/api/rest/.';

  readonly credentialCheckCurlArguments = ['https://gitlab.com/api/v4/user'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "PRIVATE-TOKEN: <token>"`;
  }
}

export const GITLAB = new Gitlab();
