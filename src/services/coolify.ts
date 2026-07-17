import { Service, tryParseJson } from './core/base.js';

export class Coolify extends Service {
  readonly name = 'coolify';
  readonly displayName = 'Coolify';
  readonly baseApiUrls = ['https://app.coolify.io/api/'] as const;
  readonly loginUrl = 'https://app.coolify.io/login';
  readonly info = 'https://coolify.io/docs/llms.txt';

  // teams/current both validates the token and identifies the team it belongs
  // to (API tokens are scoped to a team, so the team is the account).
  readonly credentialCheckCurlArguments = ['https://app.coolify.io/api/v1/teams/current'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as { name?: string; id?: number } | null;
    return data?.name ?? data?.id?.toString() ?? null;
  }
}

export const COOLIFY = new Coolify();
