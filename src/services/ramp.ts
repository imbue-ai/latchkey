/**
 * Ramp service implementation.
 *
 * Ramp's developer API uses the OAuth 2.0 client_credentials grant for
 * single-organization access. The user registers an API client in the Ramp
 * dashboard (Settings -> Developer), enables a set of scopes on it, and gives
 * latchkey the client ID, client secret, and that same set of scopes.
 *
 * Scopes in Ramp are bound to the app at creation time: a token request may only
 * ask for scopes the app already has, and asking for anything else fails with
 * `invalid_scope`. So latchkey requests exactly the scopes the user passes in --
 * no more, no less -- which means the minted token can do everything the app is
 * allowed to do and nothing it isn't. There is no refresh token in this grant;
 * latchkey simply mints a new token with the stored client credentials whenever
 * the current one is missing or expired.
 */

import { z } from 'zod';
import {
  ApiCredentials,
  ApiCredentialStatus,
  ApiCredentialsUsageError,
} from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from './core/base.js';

type RampEnvironment = 'production' | 'sandbox';

const RAMP_TOKEN_ENDPOINTS: Record<RampEnvironment, string> = {
  production: 'https://api.ramp.com/developer/v1/token',
  sandbox: 'https://demo-api.ramp.com/developer/v1/token',
};

/**
 * Treat a token as expired this long before its real expiry, so it is never
 * used right at the edge of its lifetime.
 */
const EXPIRY_BUFFER_MS = 60_000;

interface RampTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Mint a fresh access token from Ramp using the client_credentials grant.
 * Returns null if the request fails or the response is malformed.
 */
function requestRampToken(
  clientId: string,
  clientSecret: string,
  scope: string,
  environment: RampEnvironment
): RampTokenResponse | null {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: Basic ${basicAuth}`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      RAMP_TOKEN_ENDPOINTS[environment],
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }

  try {
    const response = JSON.parse(result.stdout) as Partial<RampTokenResponse>;
    if (typeof response.access_token !== 'string' || typeof response.expires_in !== 'number') {
      return null;
    }
    return { access_token: response.access_token, expires_in: response.expires_in };
  } catch {
    return null;
  }
}

/**
 * Ramp OAuth client_credentials credentials.
 *
 * Stores the client ID/secret and the exact scopes the app was granted (used to
 * mint tokens) plus the most recently minted access token. The token is injected
 * as `Authorization: Bearer`.
 */
export const RampCredentialsSchema = z.object({
  objectType: z.literal('ramp'),
  clientId: z.string(),
  clientSecret: z.string(),
  scope: z.string(),
  environment: z.enum(['production', 'sandbox']),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type RampCredentialsData = z.infer<typeof RampCredentialsSchema>;

export class RampCredentials implements ApiCredentials {
  readonly objectType = 'ramp' as const;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly environment: RampEnvironment;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    scope: string,
    environment: RampEnvironment,
    accessToken?: string,
    accessTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this.environment = environment;
    this.accessToken = accessToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'Ramp credentials have no access token yet. A token is minted automatically on use; ' +
          'if you see this, re-run the command or re-set the credentials.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
  }

  isExpired(): boolean | undefined {
    // No token yet (only client ID/secret stored): report expired so the refresh
    // path mints the first token before the request goes out.
    if (this.accessToken === undefined) {
      return true;
    }
    if (this.accessTokenExpiresAt === undefined) {
      return undefined;
    }
    return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - EXPIRY_BUFFER_MS;
  }

  /**
   * Return a copy carrying a freshly minted access token.
   */
  withToken(accessToken: string, accessTokenExpiresAt: string): RampCredentials {
    return new RampCredentials(
      this.clientId,
      this.clientSecret,
      this.scope,
      this.environment,
      accessToken,
      accessTokenExpiresAt
    );
  }

  toJSON(): RampCredentialsData {
    return {
      objectType: this.objectType,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scope: this.scope,
      environment: this.environment,
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: RampCredentialsData): RampCredentials {
    return new RampCredentials(
      data.clientId,
      data.clientSecret,
      data.scope,
      data.environment,
      data.accessToken,
      data.accessTokenExpiresAt
    );
  }
}

class RampCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('ramp');
    this.message = message;
    this.name = 'RampCredentialError';
  }
}

export class Ramp extends Service {
  readonly name = 'ramp';
  readonly displayName = 'Ramp';
  // Both the production and sandbox (demo) hosts route here; the stored
  // credential records which environment it was issued for.
  readonly baseApiUrls = ['https://api.ramp.com/', 'https://demo-api.ramp.com/'] as const;
  readonly loginUrl = 'https://app.ramp.com/';
  readonly info =
    'https://docs.ramp.com/developer-api/v1/overview. ' +
    'Uses the OAuth client_credentials grant. In the Ramp dashboard, register an API client ' +
    'under Settings -> Developer and enable the scopes you want it to have. Then store it with ' +
    '`latchkey auth set-nocurl ramp <client_id> <client_secret> <scope> [scope ...]`, passing ' +
    'the same scopes you enabled on the app (e.g. transactions:read users:read). Latchkey ' +
    'requests exactly those scopes and mints/refreshes the bearer token automatically, so the ' +
    'token can do everything the app is allowed to do and nothing more. Add `--sandbox` to use ' +
    'the demo environment (https://demo-api.ramp.com).';

  // Unused: credentials are validated by minting a token (see checkApiCredentials),
  // which is scope-independent. Kept for documentation of the simplest read call.
  readonly credentialCheckCurlArguments = [
    'https://api.ramp.com/developer/v1/transactions',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <client_id> <client_secret> <scope> [scope ...]`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    let environment: RampEnvironment = 'production';
    const positional: string[] = [];
    for (const argument of arguments_) {
      if (argument === '--sandbox' || argument === 'sandbox') {
        environment = 'sandbox';
      } else if (argument === '--production' || argument === 'production') {
        environment = 'production';
      } else if (argument !== '') {
        positional.push(argument);
      }
    }

    const [clientId, clientSecret, ...scopes] = positional;
    if (clientId === undefined || clientSecret === undefined || scopes.length === 0) {
      throw new RampCredentialError(
        'Expected: <client_id> <client_secret> <scope> [scope ...]\n' +
          'Pass the scopes you enabled on the Ramp app (Settings -> Developer), space-separated.\n' +
          'Example: latchkey auth set-nocurl ramp <client_id> <client_secret> transactions:read users:read'
      );
    }
    return new RampCredentials(clientId, clientSecret, scopes.join(' '), environment);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof RampCredentials)) {
      return Promise.resolve(null);
    }
    const token = requestRampToken(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      apiCredentials.scope,
      apiCredentials.environment
    );
    if (token === null) {
      return Promise.resolve(null);
    }
    const accessTokenExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
    return Promise.resolve(apiCredentials.withToken(token.access_token, accessTokenExpiresAt));
  }

  /**
   * Validate credentials by confirming a token can be minted, rather than by
   * hitting a specific resource endpoint. Ramp has no scope-free endpoint, so a
   * resource check would force every user to grant one particular scope; minting
   * is the scope-independent source of truth ("can these client credentials
   * obtain a token for their scopes?").
   *
   * The refresh path runs before this and mints a token when needed, so in the
   * common case we just confirm the (already refreshed) credentials hold a live
   * token; we mint here only as a fallback when they don't.
   */
  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    if (!(apiCredentials instanceof RampCredentials)) {
      return ApiCredentialStatus.Missing;
    }
    let credentials: RampCredentials | null = apiCredentials;
    if (credentials.isExpired() === true) {
      const refreshed = await this.refreshCredentials(apiCredentials);
      credentials = refreshed instanceof RampCredentials ? refreshed : null;
    }
    if (credentials?.accessToken === undefined) {
      return ApiCredentialStatus.Invalid;
    }
    return credentials.isExpired() === true
      ? ApiCredentialStatus.Invalid
      : ApiCredentialStatus.Valid;
  }
}

export const RAMP = new Ramp();
