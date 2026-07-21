/**
 * Tests for the credential check and for account determination.
 *
 * The credential check runs a single curl call whose output is the response
 * body followed by the HTTP status code on the final line (produced by
 * `-w '\n%{http_code}'`). Account determination (`getAccount`) runs its own
 * curl call against an identity-revealing endpoint and parses the account
 * from the raw response body. These tests mock the capturing subprocess
 * runner to feed service implementations recorded response bodies.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ApiCredentialStatus,
  AuthorizationBearer,
  OAuthCredentials,
} from '../src/apiCredentials/base.js';
import { resetCapturingSubprocessRunner, setCapturingSubprocessRunner } from '../src/curl.js';
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
import { ZOOM } from '../src/services/zoom.js';

const BEARER = new AuthorizationBearer('test-token');

function mockCurlOutput(stdout: string): void {
  setCapturingSubprocessRunner(() => ({ returncode: 0, stdout, stderr: '' }));
}

function withStatusLine(body: string, statusCode = '200'): string {
  return `${body}\n${statusCode}`;
}

afterEach(() => {
  resetCapturingSubprocessRunner();
});

describe('base credential check', () => {
  it('reports valid credentials on a 200 response', async () => {
    mockCurlOutput(withStatusLine('{}'));
    const status = await GITHUB.checkApiCredentials(BEARER);
    expect(status).toBe(ApiCredentialStatus.Valid);
  });

  it('reports invalid credentials on non-200 responses', async () => {
    mockCurlOutput(withStatusLine('{"message":"Bad credentials"}', '401'));
    const status = await GITHUB.checkApiCredentials(BEARER);
    expect(status).toBe(ApiCredentialStatus.Invalid);
  });

  it('reports missing credentials when injection fails', async () => {
    const tokenlessCredentials = new OAuthCredentials('client-id', 'client-secret');
    const status = await GITHUB.checkApiCredentials(tokenlessCredentials);
    expect(status).toBe(ApiCredentialStatus.Missing);
  });

  it('reports unknown status for registered services without a request', async () => {
    const registered = new RegisteredService('my-service', 'https://example.com/api/');
    const status = await registered.checkApiCredentials();
    expect(status).toBe(ApiCredentialStatus.Unknown);
  });
});

describe('base account determination', () => {
  it('returns null when the body carries no identity', async () => {
    mockCurlOutput('{}');
    const account = await GITHUB.getAccount(BEARER);
    expect(account).toBeNull();
  });

  it('returns null when credential injection fails', async () => {
    const tokenlessCredentials = new OAuthCredentials('client-id', 'client-secret');
    const account = await GITHUB.getAccount(tokenlessCredentials);
    expect(account).toBeNull();
  });

  it('never crashes on a malformed body', async () => {
    mockCurlOutput('this is not JSON');
    const account = await GITHUB.getAccount(BEARER);
    expect(account).toBeNull();
  });

  it('returns null for registered services without a request', async () => {
    const registered = new RegisteredService('my-service', 'https://example.com/api/');
    const account = await registered.getAccount();
    expect(account).toBeNull();
  });
});

describe('account parsing', () => {
  it('github uses the login handle', async () => {
    mockCurlOutput('{"login":"octocat","email":null}');
    const account = await GITHUB.getAccount(BEARER);
    expect(account).toBe('octocat');
  });

  it('gitlab uses the e-mail', async () => {
    mockCurlOutput('{"username":"jane","email":"jane@example.com"}');
    const account = await GITLAB.getAccount(BEARER);
    expect(account).toBe('jane@example.com');
  });

  it('calendly uses the e-mail from the resource', async () => {
    mockCurlOutput('{"resource":{"email":"host@example.com","name":"Host Person"}}');
    const account = await CALENDLY.getAccount(BEARER);
    expect(account).toBe('host@example.com');
  });

  it('figma uses the e-mail', async () => {
    mockCurlOutput('{"email":"designer@example.com","handle":"Designer"}');
    const account = await FIGMA.getAccount(BEARER);
    expect(account).toBe('designer@example.com');
  });

  it('discord prefers the e-mail over the username', async () => {
    mockCurlOutput('{"username":"gamer","email":"gamer@example.com","id":"1234"}');
    const account = await DISCORD.getAccount(BEARER);
    expect(account).toBe('gamer@example.com');
  });

  it('dropbox uses the e-mail from get_current_account', async () => {
    mockCurlOutput('{"account_id":"dbid:abc","email":"user@example.com"}');
    const account = await DROPBOX.getAccount(BEARER);
    expect(account).toBe('user@example.com');
  });

  it('linear uses the viewer e-mail', async () => {
    mockCurlOutput('{"data":{"viewer":{"id":"uuid-1","email":"dev@example.com"}}}');
    const account = await LINEAR.getAccount(BEARER);
    expect(account).toBe('dev@example.com');
  });

  it('mailchimp uses the login e-mail', async () => {
    mockCurlOutput('{"accountname":"Acme","login":{"email":"marketer@example.com"}}');
    const account = await MAILCHIMP.getAccount(BEARER);
    expect(account).toBe('marketer@example.com');
  });

  it('notion combines the bot name and workspace', async () => {
    mockCurlOutput('{"name":"My Integration","bot":{"workspace_name":"Acme Inc"}}');
    const account = await NOTION.getAccount(BEARER);
    expect(account).toBe('My Integration@Acme Inc');
  });

  it('telegram uses the bot username', async () => {
    mockCurlOutput('{"ok":true,"result":{"id":42,"username":"my_bot"}}');
    const account = await TELEGRAM.getAccount(BEARER);
    expect(account).toBe('my_bot');
  });

  it('aws uses the caller ARN from the XML response', async () => {
    mockCurlOutput(
      '<GetCallerIdentityResponse><GetCallerIdentityResult>' +
        '<Arn>arn:aws:iam::123456789012:user/alice</Arn>' +
        '<UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account>' +
        '</GetCallerIdentityResult></GetCallerIdentityResponse>'
    );
    const account = await AWS.getAccount(BEARER);
    expect(account).toBe('arn:aws:iam::123456789012:user/alice');
  });
});

describe('slack', () => {
  it('treats ok:false as invalid even though the HTTP status is 200', async () => {
    mockCurlOutput(withStatusLine('{"ok":false,"error":"invalid_auth"}'));
    const status = await SLACK.checkApiCredentials(BEARER);
    expect(status).toBe(ApiCredentialStatus.Invalid);
  });

  it('treats ok:true as valid', async () => {
    mockCurlOutput(withStatusLine('{"ok":true,"url":"https://acme.slack.com/","user":"jane"}'));
    const status = await SLACK.checkApiCredentials(BEARER);
    expect(status).toBe(ApiCredentialStatus.Valid);
  });

  it('combines the user and the workspace subdomain', async () => {
    mockCurlOutput('{"ok":true,"url":"https://acme.slack.com/","team":"Acme Inc","user":"jane"}');
    const account = await SLACK.getAccount(BEARER);
    expect(account).toBe('jane@acme');
  });
});

describe('sentry', () => {
  it('requires the user field for validity', async () => {
    mockCurlOutput(withStatusLine('{"user":null}'));
    const status = await SENTRY.checkApiCredentials(BEARER);
    expect(status).toBe(ApiCredentialStatus.Invalid);
  });

  it('uses the user e-mail as the account', async () => {
    mockCurlOutput('{"user":{"email":"dev@example.com"}}');
    const account = await SENTRY.getAccount(BEARER);
    expect(account).toBe('dev@example.com');
  });
});

describe('google', () => {
  it('google services determine the account via the OpenID userinfo endpoint', async () => {
    let requestedUrl: string | undefined;
    setCapturingSubprocessRunner((args) => {
      requestedUrl = args[args.length - 1];
      return {
        returncode: 0,
        stdout: '{"email":"user@gmail.com","sub":"1"}',
        stderr: '',
      };
    });
    const credentials = new OAuthCredentials('client-id', 'client-secret', 'access-token');
    const account = await GOOGLE_GMAIL.getAccount(credentials);
    expect(account).toBe('user@gmail.com');
    expect(requestedUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo');
  });

  it('google services report token-less prepared credentials as missing', async () => {
    const prepared = new OAuthCredentials('client-id', 'client-secret');
    const status = await GOOGLE_GMAIL.checkApiCredentials(prepared);
    expect(status).toBe(ApiCredentialStatus.Missing);
  });

  it('google services report tokens rejected by userinfo as invalid', async () => {
    mockCurlOutput(withStatusLine('{"error":"invalid_token"}', '401'));
    const credentials = new OAuthCredentials('client-id', 'client-secret', 'access-token');
    const status = await GOOGLE_GMAIL.checkApiCredentials(credentials);
    expect(status).toBe(ApiCredentialStatus.Invalid);
  });
});

describe('account determination via a separate endpoint', () => {
  it('stripe asks the account endpoint and prefers the e-mail', async () => {
    let requestedUrl: string | undefined;
    setCapturingSubprocessRunner((args) => {
      requestedUrl = args[args.length - 1];
      return {
        returncode: 0,
        stdout: '{"id":"acct_123","email":"owner@example.com"}',
        stderr: '',
      };
    });
    const account = await STRIPE.getAccount(BEARER);
    expect(account).toBe('owner@example.com');
    expect(requestedUrl).toBe('https://api.stripe.com/v1/account');
  });

  it('stripe leaves the account undetermined when the key may not read it', async () => {
    mockCurlOutput('{"error":{"type":"invalid_request_error"}}');
    const account = await STRIPE.getAccount(BEARER);
    expect(account).toBeNull();
  });

  it('zoom leaves the account undetermined for server-to-server tokens', async () => {
    mockCurlOutput('{"code":124,"message":"Invalid access token."}');
    const account = await ZOOM.getAccount(BEARER);
    expect(account).toBeNull();
  });

  it('zoom uses the e-mail from /users/me', async () => {
    mockCurlOutput('{"id":"abc","email":"host@example.com"}');
    const account = await ZOOM.getAccount(BEARER);
    expect(account).toBe('host@example.com');
  });
});
