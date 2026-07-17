/**
 * Tests for account determination via the credential check.
 *
 * The credential check runs a single curl call whose output is the response
 * body followed by the HTTP status code on the final line (produced by
 * `-w '\n%{http_code}'`). These tests mock the async subprocess runner to
 * feed service implementations recorded response bodies.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ApiCredentialStatus,
  AuthorizationBearer,
  OAuthCredentials,
} from '../src/apiCredentials/base.js';
import {
  resetAsyncSubprocessRunner,
  setAsyncSubprocessRunner,
} from '../src/curl.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { AWS } from '../src/services/aws.js';
import { CALENDLY } from '../src/services/calendly.js';
import { DISCORD } from '../src/services/discord.js';
import { DROPBOX } from '../src/services/dropbox.js';
import { FIGMA } from '../src/services/figma.js';
import { GITHUB } from '../src/services/github.js';
import { GITLAB } from '../src/services/gitlab.js';
import { GOOGLE_GMAIL } from '../src/services/google/gmail.js';
import { LINEAR } from '../src/services/linear.js';
import { MAILCHIMP } from '../src/services/mailchimp.js';
import { NOTION } from '../src/services/notion.js';
import { SENTRY } from '../src/services/sentry.js';
import { SLACK } from '../src/services/slack.js';
import { STRIPE } from '../src/services/stripe.js';
import { TELEGRAM } from '../src/services/telegram.js';

const BEARER = new AuthorizationBearer('test-token');

function mockCurlOutput(stdout: string): void {
  setAsyncSubprocessRunner(() =>
    Promise.resolve({ returncode: 0, stdout: Buffer.from(stdout), stderr: '' })
  );
}

function withStatusLine(body: string, statusCode = '200'): string {
  return `${body}\n${statusCode}`;
}

afterEach(() => {
  resetAsyncSubprocessRunner();
});

describe('base credential check', () => {
  it('reports valid credentials without an account when the body carries no identity', async () => {
    mockCurlOutput(withStatusLine('{"balance": []}'));
    const result = await STRIPE.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Valid, account: null });
  });

  it('reports invalid credentials on non-200 responses', async () => {
    mockCurlOutput(withStatusLine('{"message":"Bad credentials"}', '401'));
    const result = await GITHUB.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Invalid, account: null });
  });

  it('reports missing credentials when injection fails', async () => {
    const tokenlessCredentials = new OAuthCredentials('client-id', 'client-secret');
    const result = await GITHUB.checkApiCredentials(tokenlessCredentials);
    expect(result).toEqual({ status: ApiCredentialStatus.Missing, account: null });
  });

  it('never crashes on a malformed body', async () => {
    mockCurlOutput(withStatusLine('this is not JSON'));
    const result = await GITHUB.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Valid, account: null });
  });

  it('reports unknown status for registered services without a request', async () => {
    const registered = new RegisteredService('my-service', 'https://example.com/api/');
    const result = await registered.checkApiCredentials();
    expect(result).toEqual({ status: ApiCredentialStatus.Unknown, account: null });
  });
});

describe('account parsing from the credential check', () => {
  it('github uses the login handle', async () => {
    mockCurlOutput(withStatusLine('{"login":"octocat","email":null}'));
    const result = await GITHUB.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Valid, account: 'octocat' });
  });

  it('gitlab uses the e-mail', async () => {
    mockCurlOutput(withStatusLine('{"username":"jane","email":"jane@example.com"}'));
    const result = await GITLAB.checkApiCredentials(BEARER);
    expect(result.account).toBe('jane@example.com');
  });

  it('calendly uses the e-mail from the resource', async () => {
    mockCurlOutput(
      withStatusLine('{"resource":{"email":"host@example.com","name":"Host Person"}}')
    );
    const result = await CALENDLY.checkApiCredentials(BEARER);
    expect(result.account).toBe('host@example.com');
  });

  it('figma uses the e-mail', async () => {
    mockCurlOutput(withStatusLine('{"email":"designer@example.com","handle":"Designer"}'));
    const result = await FIGMA.checkApiCredentials(BEARER);
    expect(result.account).toBe('designer@example.com');
  });

  it('discord prefers the e-mail over the username', async () => {
    mockCurlOutput(
      withStatusLine('{"username":"gamer","email":"gamer@example.com","id":"1234"}')
    );
    const result = await DISCORD.checkApiCredentials(BEARER);
    expect(result.account).toBe('gamer@example.com');
  });

  it('dropbox uses the e-mail from get_current_account', async () => {
    mockCurlOutput(
      withStatusLine('{"account_id":"dbid:abc","email":"user@example.com"}')
    );
    const result = await DROPBOX.checkApiCredentials(BEARER);
    expect(result.account).toBe('user@example.com');
  });

  it('linear uses the viewer e-mail', async () => {
    mockCurlOutput(
      withStatusLine('{"data":{"viewer":{"id":"uuid-1","email":"dev@example.com"}}}')
    );
    const result = await LINEAR.checkApiCredentials(BEARER);
    expect(result.account).toBe('dev@example.com');
  });

  it('mailchimp uses the login e-mail', async () => {
    mockCurlOutput(
      withStatusLine('{"accountname":"Acme","login":{"email":"marketer@example.com"}}')
    );
    const result = await MAILCHIMP.checkApiCredentials(BEARER);
    expect(result.account).toBe('marketer@example.com');
  });

  it('notion combines the bot name and workspace', async () => {
    mockCurlOutput(
      withStatusLine('{"name":"My Integration","bot":{"workspace_name":"Acme Inc"}}')
    );
    const result = await NOTION.checkApiCredentials(BEARER);
    expect(result.account).toBe('My Integration@Acme Inc');
  });

  it('telegram uses the bot username', async () => {
    mockCurlOutput(withStatusLine('{"ok":true,"result":{"id":42,"username":"my_bot"}}'));
    const result = await TELEGRAM.checkApiCredentials(BEARER);
    expect(result.account).toBe('my_bot');
  });

  it('aws uses the caller ARN from the XML response', async () => {
    mockCurlOutput(
      withStatusLine(
        '<GetCallerIdentityResponse><GetCallerIdentityResult>' +
          '<Arn>arn:aws:iam::123456789012:user/alice</Arn>' +
          '<UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account>' +
          '</GetCallerIdentityResult></GetCallerIdentityResponse>'
      )
    );
    const result = await AWS.checkApiCredentials(BEARER);
    expect(result.account).toBe('arn:aws:iam::123456789012:user/alice');
  });
});

describe('slack credential check', () => {
  it('treats ok:false as invalid even though the HTTP status is 200', async () => {
    mockCurlOutput(withStatusLine('{"ok":false,"error":"invalid_auth"}'));
    const result = await SLACK.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Invalid, account: null });
  });

  it('combines the user and the workspace subdomain', async () => {
    mockCurlOutput(
      withStatusLine(
        '{"ok":true,"url":"https://acme.slack.com/","team":"Acme Inc","user":"jane"}'
      )
    );
    const result = await SLACK.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Valid, account: 'jane@acme' });
  });
});

describe('sentry credential check', () => {
  it('requires the user field for validity', async () => {
    mockCurlOutput(withStatusLine('{"user":null}'));
    const result = await SENTRY.checkApiCredentials(BEARER);
    expect(result).toEqual({ status: ApiCredentialStatus.Invalid, account: null });
  });

  it('uses the user e-mail', async () => {
    mockCurlOutput(withStatusLine('{"user":{"email":"dev@example.com"}}'));
    const result = await SENTRY.checkApiCredentials(BEARER);
    expect(result).toEqual({
      status: ApiCredentialStatus.Valid,
      account: 'dev@example.com',
    });
  });
});

describe('service-level determineAccount', () => {
  it('defaults to the credential-check account', async () => {
    mockCurlOutput(withStatusLine('{"login":"octocat"}'));
    expect(await GITHUB.determineAccount(BEARER)).toBe('octocat');
  });

  it('google services ask the OpenID userinfo endpoint', async () => {
    let requestedUrl: string | undefined;
    setAsyncSubprocessRunner((args) => {
      requestedUrl = args[args.length - 1];
      return Promise.resolve({
        returncode: 0,
        stdout: Buffer.from('{"email":"user@gmail.com","sub":"1"}'),
        stderr: '',
      });
    });
    const credentials = new OAuthCredentials('client-id', 'client-secret', 'access-token');
    expect(await GOOGLE_GMAIL.determineAccount(credentials)).toBe('user@gmail.com');
    expect(requestedUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo');
  });

  it('google services return null for token-less prepared credentials', async () => {
    const prepared = new OAuthCredentials('client-id', 'client-secret');
    expect(await GOOGLE_GMAIL.determineAccount(prepared)).toBeNull();
  });

  it('stripe asks the account endpoint and prefers the e-mail', async () => {
    let requestedUrl: string | undefined;
    setAsyncSubprocessRunner((args) => {
      requestedUrl = args[args.length - 1];
      return Promise.resolve({
        returncode: 0,
        stdout: Buffer.from('{"id":"acct_123","email":"owner@example.com"}'),
        stderr: '',
      });
    });
    expect(await STRIPE.determineAccount(BEARER)).toBe('owner@example.com');
    expect(requestedUrl).toBe('https://api.stripe.com/v1/account');
  });

  it('stripe returns null when the key may not read the account', async () => {
    mockCurlOutput('{"error":{"type":"invalid_request_error"}}');
    expect(await STRIPE.determineAccount(BEARER)).toBeNull();
  });
});
