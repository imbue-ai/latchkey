import {
  type ApiCredentials,
  ApiCredentialsUsageError,
} from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import { Service, tryParseJson } from './core/base.js';

export class Zoom extends Service {
  readonly name = 'zoom';
  readonly displayName = 'Zoom';
  readonly baseApiUrls = ['https://api.zoom.us/v2/'] as const;
  readonly loginUrl = 'https://zoom.us/signin';
  readonly info = 'https://developers.zoom.us/docs/api/.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://api.zoom.us/v2/users?page_size=1',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * The credential check must stay on the user-list endpoint because
   * server-to-server tokens have no user context and error on /users/me. The
   * account is instead determined by a separate best-effort call to /users/me,
   * which works for user-level tokens.
   */
  override async determineAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    let curlArguments: readonly string[];
    try {
      curlArguments = await apiCredentials.injectIntoCurlCall([
        '-s',
        'https://api.zoom.us/v2/users/me',
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return null;
      }
      throw error;
    }
    const result = runCaptured(curlArguments, 10);
    const data = tryParseJson(result.stdout) as {
      email?: string;
      id?: string;
      code?: number;
    } | null;
    if (data === null || data.code !== undefined) {
      return null;
    }
    return data.email ?? data.id ?? null;
  }
}

export const ZOOM = new Zoom();
