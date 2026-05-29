import { describe, it, expect } from 'vitest';
import {
  GITHUB,
  GithubTokenBasicAuth,
  UnexpectedGithubCredentialsError,
} from '../src/services/github.js';
import { AuthorizationBearer, RawCurlCredentials } from '../src/apiCredentials/base.js';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';

describe('Github URL matching', () => {
  it('matches the REST API host', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://api.github.com/user')).toBe(GITHUB);
    expect(SERVICE_REGISTRY.getByUrl('https://uploads.github.com/anything')).toBe(GITHUB);
  });

  it('matches git smart-HTTP operation URLs', () => {
    expect(
      SERVICE_REGISTRY.getByUrl(
        'https://github.com/owner/repo.git/info/refs?service=git-upload-pack'
      )
    ).toBe(GITHUB);
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo/info/refs')).toBe(GITHUB);
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo.git/git-upload-pack')).toBe(
      GITHUB
    );
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo/git-receive-pack')).toBe(
      GITHUB
    );
  });

  it('does not match repository web pages or website routes', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo/issues/1')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/settings/tokens')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://example.com/owner/repo.git/info/refs')).toBeNull();
  });
});

describe('Github.adjustCredentials', () => {
  it('leaves API credentials untouched', () => {
    const bearer = new AuthorizationBearer('token-123');
    const adjusted = GITHUB.adjustCredentials(bearer, 'https://api.github.com/user');
    expect(adjusted).toBe(bearer);
  });

  it('leaves credentials untouched for repository web pages', () => {
    const bearer = new AuthorizationBearer('token-123');
    const adjusted = GITHUB.adjustCredentials(bearer, 'https://github.com/owner/repo');
    expect(adjusted).toBe(bearer);
  });

  it('converts bearer credentials to basic auth for git operation URLs', async () => {
    const bearer = new AuthorizationBearer('token-123');
    const adjusted = GITHUB.adjustCredentials(
      bearer,
      'https://github.com/owner/repo.git/info/refs'
    );
    expect(adjusted).toBeInstanceOf(GithubTokenBasicAuth);

    const args = await adjusted.injectIntoCurlCall(['https://github.com/owner/repo.git']);
    expect(args).toEqual(['-u', 'x-access-token:token-123', 'https://github.com/owner/repo.git']);
  });

  it('throws when git operation credentials are not bearer credentials', () => {
    const raw = new RawCurlCredentials(['-H', 'X-Custom: 1']);
    expect(() =>
      GITHUB.adjustCredentials(raw, 'https://github.com/owner/repo.git/git-upload-pack')
    ).toThrow(UnexpectedGithubCredentialsError);
  });
});
