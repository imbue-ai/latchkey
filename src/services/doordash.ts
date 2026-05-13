/**
 * DoorDash service implementation.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import type { ApiCredentials } from '../apiCredentials/base.js';
import { Service, SimpleServiceSession } from './core/base.js';

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

class DoorDashServiceSession extends SimpleServiceSession {
  protected getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    const url = response.url();

    if (!/^https:\/\/([a-z0-9-]+\.)?doordash\.com\//.test(url)) {
      return null;
    }

    const headers = response.headers();
    const setCookie = headers['set-cookie'] ?? '';
    if (!setCookie.includes('ddweb_token')) {
      return null;
    }

    const ddwebMatch = /\bddweb_token=([^;]+)/.exec(setCookie);
    if (!ddwebMatch?.[1]) {
      return null;
    }

    const csrfMatch = /\bcsrf_token=([^;]+)/.exec(setCookie);
    if (!csrfMatch?.[1]) {
      return null;
    }

    return new DoorDashApiCredentials(ddwebMatch[1], csrfMatch[1]);
  }
}

export class Doordash extends Service {
  readonly name = 'doordash';
  readonly displayName = 'DoorDash';
  readonly baseApiUrls = ['https://consumer-api-gateway.doordash.com/'] as const;
  readonly loginUrl = 'https://www.doordash.com/consumer/login/';
  readonly info =
    'DoorDash consumer API. ' +
    'Credentials are session cookies extracted from browser login.';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"query":"{ currentUser { id } }"}',
    'https://consumer-api-gateway.doordash.com/graphql',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Cookie: ddweb_token=YOUR_TOKEN; csrf_token=YOUR_CSRF"`;
  }

  override getSession(): DoorDashServiceSession {
    return new DoorDashServiceSession(this);
  }
}

export const DOORDASH = new Doordash();
