/**
 * Tests for the credential request shown when a browser automation fails: the
 * user pastes what they created by hand into a form, and the page hands it back
 * to latchkey.
 *
 * Browser-free: the context and page are stand-ins exposing only what the
 * request uses, which also lets the exposed binding be called directly.
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import type { BrowserContext, Page } from 'playwright';
import {
  CredentialFormFieldMissingError,
  CredentialFormValues,
  parseSubmittedCredentialValues,
  requestCredentialsFromUser,
  type CredentialFormDecision,
  type CredentialFormField,
} from '../src/playwrightUtils.js';
import { GITHUB_MANUAL_CREDENTIAL_FORM } from '../src/services/github.js';
import { AuthorizationBearer } from '../src/apiCredentials/base.js';

const FORM_FIELDS: readonly CredentialFormField[] = [
  { name: 'clientId', label: 'Client ID' },
  { name: 'clientSecret', label: 'Client secret', hint: 'From the app page' },
];

type SubmitCredentials = (values: unknown) => Promise<{ accepted?: true; problem?: string }>;

interface FakeBrowser {
  /** Resolves once the request has rendered its form. */
  readonly shown: Promise<void>;
  /** The script the overlay would have been built with. */
  readonly getRenderedScript: () => string;
  /** The form's way of handing a submission over, once the request is up. */
  readonly submit: SubmitCredentials;
  readonly closeBrowser: () => void;
  readonly context: BrowserContext;
  readonly page: Page;
}

function createFakeBrowser(): FakeBrowser {
  let renderedScript = '';
  let submitBinding: SubmitCredentials | undefined;
  const closeListeners: (() => void)[] = [];
  let markAsShown: () => void = () => {
    /* replaced below */
  };
  const shown = new Promise<void>((resolve) => {
    markAsShown = resolve;
  });

  const page = {
    isClosed: () => false,
    bringToFront: () => Promise.resolve(),
    exposeFunction: (_name: string, binding: SubmitCredentials) => {
      submitBinding = binding;
      return Promise.resolve();
    },
    evaluate: (script: string) => {
      renderedScript = script;
      markAsShown();
      return Promise.resolve(undefined);
    },
    on: (event: string, listener: () => void) => {
      if (event === 'close') {
        closeListeners.push(listener);
      }
    },
  } as unknown as Page;

  const context = {
    newPage: () => Promise.resolve(page),
    on: () => undefined,
    browser: () => ({ on: () => undefined }),
  } as unknown as BrowserContext;

  return {
    shown,
    getRenderedScript: () => renderedScript,
    submit: (values) => {
      if (submitBinding === undefined) {
        throw new Error('The credential request has not been shown yet.');
      }
      return submitBinding(values);
    },
    closeBrowser: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
    context,
    page,
  };
}

const NEVER_MS = 60_000;

describe('requestCredentialsFromUser', () => {
  it('returns what the user submitted once it is accepted', async () => {
    const browser = createFakeBrowser();
    const request = requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: (values) =>
        Promise.resolve({ accepted: `${values.get('clientId')}:${values.get('clientSecret')}` }),
      timeoutMs: NEVER_MS,
    });

    await browser.shown;
    const decision = await browser.submit({ clientId: 'id-1', clientSecret: 'secret-1' });

    expect(decision).toEqual({ accepted: true });
    await expect(request).resolves.toBe('id-1:secret-1');
  });

  it('reports a refusal back to the form and keeps waiting', async () => {
    const browser = createFakeBrowser();
    const decisions: CredentialFormDecision<string>[] = [
      { problem: 'GitHub did not accept these credentials.' },
      { accepted: 'second-try' },
    ];
    const request = requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: () => Promise.resolve(decisions.shift() ?? { problem: 'no more decisions' }),
      timeoutMs: NEVER_MS,
    });
    await browser.shown;

    const refusal = await browser.submit({ clientId: 'id-1', clientSecret: 'wrong' });
    expect(refusal).toEqual({ problem: 'GitHub did not accept these credentials.' });

    const acceptance = await browser.submit({ clientId: 'id-1', clientSecret: 'right' });
    expect(acceptance).toEqual({ accepted: true });
    await expect(request).resolves.toBe('second-try');
  });

  it('turns a failure to build the credentials into a problem for the user', async () => {
    const browser = createFakeBrowser();
    void requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: () => Promise.reject(new SyntaxError('That is not a valid client id.')),
      timeoutMs: 50,
    });
    await browser.shown;

    expect(await browser.submit({ clientId: 'nonsense', clientSecret: 'secret-1' })).toEqual({
      problem: 'That is not a valid client id.',
    });
  });

  it('asks for the missing fields instead of bothering the caller', async () => {
    const browser = createFakeBrowser();
    let decideCalls = 0;
    void requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: () => {
        decideCalls++;
        return Promise.resolve({ accepted: 'never' });
      },
      timeoutMs: 50,
    });
    await browser.shown;

    expect(await browser.submit({ clientId: 'id-1' })).toEqual({
      problem: 'Please fill in every field.',
    });
    expect(decideCalls).toBe(0);
  });

  it('gives up when the user closes the browser', async () => {
    const browser = createFakeBrowser();
    const request = requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: () => Promise.resolve({ accepted: 'never' }),
      timeoutMs: NEVER_MS,
    });
    await browser.shown;

    browser.closeBrowser();
    await expect(request).resolves.toBeNull();
  });

  it('gives up when the request times out', async () => {
    const browser = createFakeBrowser();
    const request = requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: 'Automation failed',
      details: 'Do it yourself',
      fields: FORM_FIELDS,
      decide: () => Promise.resolve({ accepted: 'never' }),
      timeoutMs: 10,
    });
    await expect(request).resolves.toBeNull();
  });
});

/**
 * The overlay is built as a source string, so a mistake in it only shows up in a
 * real browser. Parsing what we would send catches that here instead — with
 * texts full of the characters that would break a naive template.
 */
describe('credential request page script', () => {
  const AWKWARD_MESSAGE = "Backtick ` and <b>markup</b> and ${braces} and 'quotes'";
  const AWKWARD_DETAILS = 'Line one\nLine `two` with "quotes" and ${more}';

  it('parses as JavaScript and carries the field texts', async () => {
    const browser = createFakeBrowser();
    void requestCredentialsFromUser<string>({
      context: browser.context,
      spinnerPage: browser.page,
      message: AWKWARD_MESSAGE,
      details: AWKWARD_DETAILS,
      fields: [{ name: 'clientId', label: 'Client `ID`', hint: 'Looks like ${this}' }],
      decide: () => Promise.resolve({ accepted: 'never' }),
      timeoutMs: 10,
    });
    await browser.shown;

    const script = browser.getRenderedScript();
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain('Client `ID`');
    expect(script).toContain('clientId');
    expect(script).toContain('__latchkeySubmitCredentials');
  });
});

describe('parseSubmittedCredentialValues', () => {
  it('accepts a complete set of values', () => {
    const values = parseSubmittedCredentialValues(
      { clientId: 'id-1', clientSecret: 'secret-1' },
      FORM_FIELDS
    );
    expect(values?.get('clientId')).toBe('id-1');
    expect(values?.get('clientSecret')).toBe('secret-1');
  });

  it('rejects submissions with a missing or empty field', () => {
    expect(parseSubmittedCredentialValues({ clientId: 'id-1' }, FORM_FIELDS)).toBeNull();
    expect(
      parseSubmittedCredentialValues({ clientId: 'id-1', clientSecret: '' }, FORM_FIELDS)
    ).toBeNull();
  });

  it('rejects anything that is not a set of values', () => {
    expect(parseSubmittedCredentialValues('token', FORM_FIELDS)).toBeNull();
    expect(parseSubmittedCredentialValues(null, FORM_FIELDS)).toBeNull();
  });
});

describe('CredentialFormValues', () => {
  it('rejects reading a field the form does not have', () => {
    const values = new CredentialFormValues(new Map([['token', 'ghp_1']]));
    expect(() => values.get('somethingElse')).toThrow(CredentialFormFieldMissingError);
  });
});

describe('GitHub manual credential form', () => {
  it('turns a pasted token into bearer credentials', async () => {
    expect(GITHUB_MANUAL_CREDENTIAL_FORM.fields).toHaveLength(1);
    const field = GITHUB_MANUAL_CREDENTIAL_FORM.fields[0];
    const values = new CredentialFormValues(new Map([[field?.name ?? '', 'ghp_pasted']]));
    const credentials = GITHUB_MANUAL_CREDENTIAL_FORM.buildCredentials(values);
    expect(credentials).toBeInstanceOf(AuthorizationBearer);
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'Authorization: Bearer ghp_pasted',
    ]);
  });
});
