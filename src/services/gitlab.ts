import { Service } from './base.js';

export class Gitlab extends Service {
  readonly name = 'gitlab';
  readonly displayName = 'GitLab';
  readonly baseApiUrls = ['https://gitlab.com/api/', /^https:\/\/[^/]+\/api\/v4\//] as const;
  readonly loginUrl = 'https://gitlab.com/users/sign_in';
  readonly info =
    'https://docs.gitlab.com/api/rest/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set gitlab -H "PRIVATE-TOKEN: <token>"` to add credentials manually. ' +
    'Create a personal access token at https://gitlab.com/-/user_settings/personal_access_tokens.';

  readonly credentialCheckCurlArguments = ['https://gitlab.com/api/v4/user'] as const;
}

export const GITLAB = new Gitlab();
