import { Service, tryParseJson } from './core/base.js';

export class Umami extends Service {
  readonly name = 'umami';
  readonly displayName = 'Umami';
  readonly baseApiUrls = ['https://api.umami.is/'] as const;
  readonly loginUrl = 'https://cloud.umami.is/login';
  readonly info = 'https://umami.is/docs/api.';

  // /v1/me both validates the API key and identifies the account (it is one of
  // the few endpoints allowed for API-key authentication).
  readonly credentialCheckCurlArguments = ['https://api.umami.is/v1/me'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "x-umami-api-key: <api-key>"`;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    // On Umami Cloud the username is the account e-mail.
    const data = tryParseJson(responseBody) as {
      user?: { username?: string; id?: string };
    } | null;
    return data?.user?.username ?? data?.user?.id ?? null;
  }
}

export const UMAMI = new Umami();
