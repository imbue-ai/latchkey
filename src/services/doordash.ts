/**
 * DoorDash service implementation.
 */

import type { Browser, BrowserContext, Response } from 'playwright';
import { z } from 'zod';
import {
  ApiCredentialStatus,
  ApiCredentialsUsageError,
  type ApiCredentials,
} from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import { Service, ServiceSession } from './core/base.js';

export const DoorDashApiCredentialsSchema = z.object({
  objectType: z.literal('doordash'),
  ddwebToken: z.string(),
  csrfToken: z.string(),
});

export type DoorDashApiCredentialsData = z.infer<typeof DoorDashApiCredentialsSchema>;

export class DoorDashApiCredentials implements ApiCredentials {
  readonly objectType = 'doordash' as const;
  readonly ddwebToken: string;
  readonly csrfToken: string;

  constructor(ddwebToken: string, csrfToken: string) {
    this.ddwebToken = ddwebToken;
    this.csrfToken = csrfToken;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve([
      '-H',
      `Cookie: ddweb_token=${this.ddwebToken}; csrf_token=${this.csrfToken}`,
      '-H',
      `x-csrftoken: ${this.csrfToken}`,
      '-H',
      'x-channel-id: marketplace',
      '-H',
      'x-experience-id: doordash',
      '-H',
      'Origin: https://www.doordash.com',
      '-H',
      'Referer: https://www.doordash.com/',
      ...curlArguments,
    ]);
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): DoorDashApiCredentialsData {
    return {
      objectType: this.objectType,
      ddwebToken: this.ddwebToken,
      csrfToken: this.csrfToken,
    };
  }

  static fromJSON(data: DoorDashApiCredentialsData): DoorDashApiCredentials {
    return new DoorDashApiCredentials(data.ddwebToken, data.csrfToken);
  }
}

class DoorDashServiceSession extends ServiceSession {
  private loginComplete = false;

  onResponse(response: Response): void {
    if (this.loginComplete) return;
    const url = response.url();
    // After login, /post-login/ fires a postLoginQuery GraphQL mutation whose response
    // sets the ddweb_token cookie. Detect that Set-Cookie as the login completion signal.
    // Note: response.headers() does not reliably return multi-value set-cookie headers
    // in Playwright — must use headersArray().
    if (url.startsWith('https://www.doordash.com/graphql')) {
      response
        .headersArray()
        .then((headers) => {
          for (const h of headers) {
            if (h.name.toLowerCase() === 'set-cookie' && h.value.includes('ddweb_token')) {
              this.loginComplete = true;
              break;
            }
          }
        })
        .catch(() => {
          // Ignore errors reading headers
        });
    }
  }

  protected isLoginComplete(): boolean {
    return this.loginComplete;
  }

  protected async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext
  ): Promise<ApiCredentials | null> {
    // Cookies are on .doordash.com — fetch all cookies (no URL filter)
    const cookies = await context.cookies();
    const ddweb = cookies.find((c) => c.name === 'ddweb_token');
    const csrf = cookies.find((c) => c.name === 'csrf_token');

    if (!ddweb?.value || !csrf?.value) {
      return null;
    }

    return new DoorDashApiCredentials(ddweb.value, csrf.value);
  }
}

export class Doordash extends Service {
  readonly name = 'doordash';
  readonly displayName = 'DoorDash';
  readonly baseApiUrls = ['https://www.doordash.com/graphql'] as const;
  readonly loginUrl = 'https://www.doordash.com/consumer/login/';
  override readonly transport = 'cycletls' as const;
  readonly info =
    'DoorDash consumer API. ' +
    'Credentials are session cookies extracted from browser login.';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-H',
    'Accept: application/json',
    '-d',
    '{"query":"{ consumer { id email } }"}',
    'https://www.doordash.com/graphql/consumer?operation=consumer',
  ] as const;

  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    let allCurlArgs: readonly string[];
    try {
      allCurlArgs = await apiCredentials.injectIntoCurlCall([
        '-s',
        ...this.credentialCheckCurlArguments,
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return ApiCredentialStatus.Missing;
      }
      throw error;
    }

    const result = runCaptured(allCurlArgs, 10);
    if (result.returncode !== 0) {
      return ApiCredentialStatus.Invalid;
    }

    try {
      const data = JSON.parse(result.stdout);
      const consumer = data?.data?.consumer;
      if (consumer?.id !== null && consumer?.id !== undefined) {
        return ApiCredentialStatus.Valid;
      }
      return ApiCredentialStatus.Invalid;
    } catch {
      return ApiCredentialStatus.Invalid;
    }
  }

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Cookie: ddweb_token=YOUR_TOKEN; csrf_token=YOUR_CSRF"`;
  }

  override getSession(): DoorDashServiceSession {
    return new DoorDashServiceSession(this);
  }
}

export const DOORDASH = new Doordash();
