import { Service, tryParseJson } from './core/base.js';

export class Sentry extends Service {
  readonly name = 'sentry';
  readonly displayName = 'Sentry';
  readonly baseApiUrls = ['https://sentry.io/api/'] as const;
  readonly loginUrl = 'https://sentry.io/auth/login/';
  readonly info = 'https://docs.sentry.io/api/.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://sentry.io/api/0/',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  // The root API endpoint responds HTTP 200 even without valid credentials;
  // authenticated requests are recognizable by the `user` field in the body.
  protected override isCredentialCheckResponseValid(
    _httpStatusCode: string,
    responseBody: string
  ): boolean {
    const data = tryParseJson(responseBody) as { user?: unknown } | null;
    return data?.user !== undefined && data.user !== null && data.user !== false;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as {
      user?: { email?: string; username?: string; id?: string };
    } | null;
    return data?.user?.email ?? data?.user?.username ?? data?.user?.id ?? null;
  }
}

export const SENTRY = new Sentry();
