import {
  ApiCredentialStatus,
  type ApiCredentials,
  ApiCredentialsUsageError,
} from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service } from './base.js';

export class Sentry extends Service {
  readonly name = 'sentry';
  readonly displayName = 'Sentry';
  readonly baseApiUrls = ['https://sentry.io/api/'] as const;
  readonly loginUrl = 'https://sentry.io/auth/login/';
  readonly info =
    'https://docs.sentry.io/api/. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set sentry -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://sentry.io/api/0/',
  ] as const;

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    let curlArgs: readonly string[];
    try {
      curlArgs = apiCredentials.asCurlArguments();
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return ApiCredentialStatus.Missing;
      }
      throw error;
    }

    const result = runCaptured(['-s', ...curlArgs, ...this.credentialCheckCurlArguments], 10);

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
