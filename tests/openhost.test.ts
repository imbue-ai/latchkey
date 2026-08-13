/**
 * Tests for the OpenHost family connector.
 *
 * The mint step (with the subprocess runner swapped out) and the cookie
 * detection are exercised directly; the family's registration onto a
 * self-hosted instance goes through the same public path a real registration
 * takes, and asserts the login binds to the instance's URLs rather than the
 * family template's.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ApiCredentialStatus, AuthorizationBearer } from '../src/apiCredentials/base.js';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import { mintOpenhostToken, Openhost, OPENHOST, setsCookie } from '../src/services/openhost.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { ServiceSession } from '../src/services/index.js';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';

const INSTANCE_ORIGIN = 'https://oh.example.com';
// The instance is registered with its root as the base API URL (OpenHost serves
// owner endpoints outside /api/ too), not an /api/-scoped base.
const INSTANCE_BASE = 'https://oh.example.com/';
const INSTANCE_LOGIN = 'https://oh.example.com/login';

async function headerFrom(credentials: ApiCredentials): Promise<string | null> {
  const curlArguments = await credentials.injectIntoCurlCall([]);
  return curlArguments[1] ?? null;
}

/** Record every mint request, and answer with a fixed status + JSON body. */
function stubMint(response: { returncode?: number; stdout?: string; stderr?: string }): {
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  setAsyncSubprocessRunner((args) => {
    calls.push(args);
    return Promise.resolve({
      returncode: response.returncode ?? 0,
      stdout: Buffer.from(response.stdout ?? ''),
      stderr: response.stderr ?? '',
    });
  });
  return { calls };
}

afterEach(() => {
  resetAsyncSubprocessRunner();
});

describe('setsCookie', () => {
  it('detects a non-empty assignment to the named cookie', () => {
    expect(setsCookie('session_token=abc123; Path=/; HttpOnly', 'session_token')).toBe(true);
  });

  it('ignores other names, empty values and non-assignments', () => {
    expect(setsCookie('other=abc; Path=/', 'session_token')).toBe(false);
    expect(setsCookie('session_token=; Path=/', 'session_token')).toBe(false);
    expect(setsCookie('not-a-cookie', 'session_token')).toBe(false);
    expect(setsCookie('=orphan', 'session_token')).toBe(false);
  });
});

describe('mintOpenhostToken', () => {
  it('mints a never-expiring token and stores it as a bearer credential', async () => {
    const { calls } = stubMint({ stdout: JSON.stringify({ token: 'secret-token' }) });
    const credentials = await mintOpenhostToken(INSTANCE_ORIGIN, 'session_token=abc', 'my-app');
    expect(await headerFrom(credentials)).toBe('Authorization: Bearer secret-token');

    const args = calls[0]!;
    // POSTs the instance's create-token endpoint, with the session cookie and a
    // same-origin Origin, asking for a never-expiring token named after the app.
    expect(args).toContain('POST');
    expect(args).toContain('https://oh.example.com/api/tokens');
    expect(args).toContain('Cookie: session_token=abc');
    expect(args).toContain('Origin: https://oh.example.com');
    const body = JSON.parse(args[args.indexOf('--data') + 1]!) as Record<string, unknown>;
    expect(body).toEqual({ name: 'my-app', expiry_hours: 'never' });
  });

  it('fails when curl fails, the body is not JSON, or the token is absent', async () => {
    stubMint({ returncode: 7, stderr: 'connection refused' });
    await expect(mintOpenhostToken(INSTANCE_ORIGIN, 'session_token=abc', 'app')).rejects.toThrow(
      /Minting an OpenHost API token failed/
    );

    stubMint({ stdout: '<html>login</html>' });
    await expect(mintOpenhostToken(INSTANCE_ORIGIN, 'session_token=abc', 'app')).rejects.toThrow(
      /did not return JSON/
    );

    stubMint({ stdout: JSON.stringify({ nope: 1 }) });
    await expect(mintOpenhostToken(INSTANCE_ORIGIN, 'session_token=abc', 'app')).rejects.toThrow(
      /returned no token/
    );
  });
});

describe('the OpenHost family', () => {
  it('is registered, autoallows Imbue-hosted instances, and has no login URL', () => {
    expect(SERVICE_REGISTRY.getByName('openhost')).toBe(OPENHOST);
    // The bare family carries no login URL, but it does match Imbue-hosted
    // instances (`<customer>.selfhost.imbue.com` and their app subdomains)
    // so a user with a token for one of those needs no registration.
    expect(OPENHOST.baseApiUrls).toEqual([expect.any(RegExp)]);
    const pattern = OPENHOST.baseApiUrls[0];
    expect(pattern.test('https://acme.selfhost.imbue.com/api/apps')).toBe(true);
    expect(pattern.test('https://myapp.acme.selfhost.imbue.com/')).toBe(true);
    expect(pattern.test('https://acme.selfhost.imbue.com.evil.com/')).toBe(false);
    expect(pattern.test('https://selfhost.imbue.com/')).toBe(false);
    expect(OPENHOST.loginUrl).toBe('');
  });

  it('needs no account label', async () => {
    expect(await new Openhost().getAccount({} as ApiCredentials)).toBeNull();
  });

  it('signs a registered instance in at its own URLs, not the family template', () => {
    // A self-hosted instance registered against the family.
    const instance = new RegisteredService('openhost-mine', INSTANCE_BASE, {
      familyService: OPENHOST,
      loginUrl: INSTANCE_LOGIN,
    });
    expect(instance.getSession).toBeDefined(); // eslint-disable-line @typescript-eslint/unbound-method
    const session = instance.getSession!('latchkey');
    expect(session).toBeInstanceOf(ServiceSession);
    // The login reads its URLs from the session's service: for a registered
    // instance that must be the instance's URLs (this is the family-binding fix),
    // not the empty family template.
    expect(session.service.loginUrl).toBe(INSTANCE_LOGIN);
  });

  it('matches the instance host and one subdomain label on top of it, but not deeper nesting or lookalikes', () => {
    const instance = new RegisteredService('openhost-mine', INSTANCE_BASE, {
      familyService: OPENHOST,
      loginUrl: INSTANCE_LOGIN,
    });
    const pattern = instance.baseApiUrls[0];
    expect(pattern).toBeInstanceOf(RegExp);
    const matches = (url: string): boolean =>
      instance.baseApiUrls.some((base) =>
        base instanceof RegExp ? base.test(url) : url.startsWith(base)
      );

    // The owner API on the host, and a client app on a single subdomain label.
    expect(matches('https://oh.example.com/api/apps')).toBe(true);
    expect(matches('https://oh.example.com/stop_app/abc')).toBe(true);
    expect(matches('https://my-app.oh.example.com/')).toBe(true);
    // Arbitrarily nested subdomains are NOT matched -- OpenHost only ever
    // serves apps one label below the instance host.
    expect(matches('https://deep.nested.oh.example.com/x')).toBe(false);
    // Not a different domain that merely ends with the host's text.
    expect(matches('https://oh.example.com.evil.com/')).toBe(false);
    expect(matches('https://notoh.example.com/')).toBe(false);
  });
});

describe('registered instance credential status', () => {
  const creds = new AuthorizationBearer('tok');

  /** Answer the credential check with a body + status code, the way curl's -w does. */
  function stubCheck(status: string): void {
    setAsyncSubprocessRunner(() =>
      Promise.resolve({ returncode: 0, stdout: Buffer.from(`<html>\n${status}`), stderr: '' })
    );
  }

  it('checks an OpenHost instance against its own /dashboard', () => {
    expect(OPENHOST.registeredCredentialCheckCurlArguments('https://oh.example.com/')).toEqual([
      'https://oh.example.com/dashboard',
    ]);
  });

  it('reports valid on 200 and invalid on the /login redirect', async () => {
    const instance = new RegisteredService('openhost-mine', INSTANCE_BASE, {
      familyService: OPENHOST,
      loginUrl: INSTANCE_LOGIN,
    });
    stubCheck('200');
    expect(await instance.checkApiCredentials(creds)).toBe(ApiCredentialStatus.Valid);
    stubCheck('302');
    expect(await instance.checkApiCredentials(creds)).toBe(ApiCredentialStatus.Invalid);
  });

  it('stays unknown for a generic registered service with no family check', async () => {
    const generic = new RegisteredService('intranet', 'https://intranet.example.com/api/');
    expect(await generic.checkApiCredentials(creds)).toBe(ApiCredentialStatus.Unknown);
  });
});
