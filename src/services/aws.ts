import { Service } from './base.js';

export class Aws extends Service {
  readonly name = 'aws';
  readonly displayName = 'AWS';
  readonly baseApiUrls = [/^https:\/\/[^/]*\.amazonaws\.com\//] as const;
  readonly loginUrl = 'https://console.aws.amazon.com/';
  readonly info =
    'https://docs.aws.amazon.com/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set aws -H "Authorization: AWS4-HMAC-SHA256 ..."` or configure credentials ' +
    'via the AWS CLI (`aws configure`). ' +
    'Create access keys at https://console.aws.amazon.com/iam/home#/security_credentials.';

  readonly credentialCheckCurlArguments = [
    'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
  ] as const;
}

export const AWS = new Aws();
