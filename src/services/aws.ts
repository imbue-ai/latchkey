import { ApiCredentials, ApiCredentialStatus, AwsCredentials } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from './base.js';

export class Aws extends Service {
  readonly name = 'aws';
  readonly displayName = 'AWS';
  readonly baseApiUrls = [/^https:\/\/[^/]*\.amazonaws\.com\//] as const;
  readonly loginUrl = 'https://console.aws.amazon.com/';
  readonly info =
    'https://docs.aws.amazon.com/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set-nocurl aws <access-key-id> <secret-access-key>` to store credentials. ' +
    'Create access keys at https://console.aws.amazon.com/iam/home#/security_credentials.';

  readonly credentialCheckCurlArguments = [
    'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
  ] as const;

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 2 || arguments_[0] === undefined || arguments_[1] === undefined) {
      throw new AwsCredentialError(
        'Expected exactly two arguments: <access-key-id> <secret-access-key>.\n' +
          'Example: latchkey auth set-nocurl aws AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
      );
    }
    const accessKeyId = arguments_[0];
    const secretAccessKey = arguments_[1];
    if (!accessKeyId.startsWith('AKIA') && !accessKeyId.startsWith('ASIA')) {
      throw new AwsCredentialError(
        "The provided access key ID doesn't look like an AWS access key ID " +
          '(expected to start with AKIA or ASIA).\n' +
          'Example: AKIAIOSFODNN7EXAMPLE'
      );
    }
    return new AwsCredentials(accessKeyId, secretAccessKey);
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    const allCurlArgs = apiCredentials.injectIntoCurlCall([
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      ...this.credentialCheckCurlArguments,
    ]);

    const result = runCaptured(allCurlArgs, 10);

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

class AwsCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('aws');
    this.message = message;
    this.name = 'AwsCredentialError';
  }
}

export const AWS = new Aws();
