import {
  ApiCredentialStatus,
  type ApiCredentials,
  ApiCredentialsUsageError,
} from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service } from './core/base.js';

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

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    let allCurlArgs: readonly string[];
    try {
      allCurlArgs = apiCredentials.injectIntoCurlCall(['-s', ...this.credentialCheckCurlArguments]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return ApiCredentialStatus.Missing;
      }
      throw error;
    }

    const result = runCaptured(allCurlArgs, 10);

    try {
      const data = JSON.parse(result.stdout) as { user?: unknown };
      if (data.user) {
        return ApiCredentialStatus.Valid;
      }
      return ApiCredentialStatus.Invalid;
    } catch {
      return ApiCredentialStatus.Invalid;
    }
  }
}

export const SENTRY = new Sentry();
