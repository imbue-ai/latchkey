import { Service } from './core/base.js';
import { tryParseJson } from '../apiCredentials/account.js';

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

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    // Unlike lookups of other users, /user always exposes the token owner's
    // own e-mail, so it can be preferred over the username.
    const data = tryParseJson(responseBody) as { username?: string; email?: string } | null;
    return data?.email ?? data?.username ?? null;
  }
}

export const GITLAB = new Gitlab();
