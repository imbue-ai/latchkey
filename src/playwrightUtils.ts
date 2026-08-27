/**
 * Playwright utility functions for browser automation.
 */

export class BrowserDisabledError extends Error {
  constructor() {
    super('Browser is disabled via LATCHKEY_DISABLE_BROWSER environment variable.');
    this.name = 'BrowserDisabledError';
  }
}

export class GraphicalEnvironmentNotFoundError extends Error {
  constructor() {
    super(
      'No graphical environment detected (neither DISPLAY nor WAYLAND_DISPLAY is set). ' +
        'Browser-based authentication requires a graphical environment.'
    );
    this.name = 'GraphicalEnvironmentNotFoundError';
  }
}

/**
 * Check whether a graphical environment is available.
 * On Linux, this requires DISPLAY or WAYLAND_DISPLAY to be set.
 * On other platforms (macOS, Windows), a display is assumed to be available.
 */
export function hasGraphicalEnvironment(): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const display = process.env.DISPLAY;
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  return (
    (display !== undefined && display !== '') ||
    (waylandDisplay !== undefined && waylandDisplay !== '')
  );
}

export class BrowserFlowsNotSupportedError extends Error {
  constructor(serviceName: string, authSubcommand: 'set' | 'set-nocurl' = 'set') {
    super(
      `Service '${serviceName}' does not support browser flows. Use 'latchkey auth ${authSubcommand} ${serviceName}' to set credentials manually.`
    );
    this.name = 'BrowserFlowNotSupportedError';
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator, LaunchOptions } from 'playwright';
import { EncryptedStorage } from './encryptedStorage.js';
import { loadPlaywright } from './playwrightLoader.js';

export interface BrowserWithContext {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

export interface BrowserLaunchOptions {
  /** Path to the browser executable. If not provided, Playwright's default is used. */
  executablePath?: string;
  /** Path to the encrypted browser state file for persisting cookies/storage. */
  browserStatePath?: string;
}

/**
 * Generate a random app name using the given prefix.
 * Used for creating unique names when registering API keys, apps, or tokens.
 */
export function generateLatchkeyAppName(appNamePrefix: string, suffix?: string): string {
  const date = new Date().toISOString().slice(5, 10);
  const randomSuffix = randomUUID().slice(0, 2);
  return `${appNamePrefix}-${date}-${randomSuffix}${suffix ?? ''}`;
}

/**
 * Save a screenshot, HTML, and URL of every open page to a temp directory.
 * Returns the directory path on success, null if anything goes wrong.
 *
 * Used to dump visible state when a Playwright flow fails so a user can
 * inspect what the page actually looked like instead of guessing from a
 * stack trace.
 */
async function captureFailureArtifacts(context: BrowserContext): Promise<string | null> {
  try {
    const pages = context.pages();
    if (pages.length === 0) {
      return null;
    }
    const dir = mkdtempSync(join(tmpdir(), 'latchkey-failure-'));
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      const prefix = pages.length === 1 ? 'page' : `page-${String(i)}`;
      try {
        await page.screenshot({ path: join(dir, `${prefix}.png`), fullPage: true });
      } catch {
        // best-effort
      }
      try {
        const html = await page.content();
        writeFileSync(join(dir, `${prefix}.html`), html, { encoding: 'utf-8' });
      } catch {
        // best-effort
      }
      try {
        writeFileSync(join(dir, `${prefix}.url.txt`), page.url(), { encoding: 'utf-8' });
      } catch {
        // best-effort
      }
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * Run a callback with a browser context initialized from encrypted storage state.
 * After the callback completes, persists browser state back to encrypted storage.
 */
export async function withTempBrowserContext<T>(
  encryptedStorage: EncryptedStorage,
  options: BrowserLaunchOptions,
  callback: (state: BrowserWithContext) => Promise<T>
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'latchkey-browser-state-'));
  const tempFilePath = join(tempDir, 'browser_state.json');

  let initialStorageState: string | undefined;
  if (options.browserStatePath && existsSync(options.browserStatePath)) {
    const content = encryptedStorage.readFile(options.browserStatePath);
    if (content !== null) {
      writeFileSync(tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });
      initialStorageState = tempFilePath;
    }
  }

  const { chromium } = await loadPlaywright();
  // Strip the most obvious automation tells so services like Google's sign-in let us through.
  const playwrightLaunchOptions: LaunchOptions = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (options.executablePath) {
    playwrightLaunchOptions.executablePath = options.executablePath;
  }
  const browser = await chromium.launch(playwrightLaunchOptions);

  let context: BrowserContext | undefined;
  try {
    const contextOptions: { storageState?: string } = {
      storageState: initialStorageState,
    };
    context = await browser.newContext(contextOptions);

    const result = await callback({ browser, context });

    // Persist browser state back to encrypted storage
    if (options.browserStatePath) {
      await context.storageState({ path: tempFilePath });
      const content = readFileSync(tempFilePath, 'utf-8');
      encryptedStorage.writeFile(options.browserStatePath, content);
    }

    return result;
  } catch (error) {
    if (process.env.LATCHKEY_DEBUG === '1') {
      if (context) {
        const artifactsDir = await captureFailureArtifacts(context);
        if (artifactsDir) {
          console.error(
            `[latchkey] Browser flow failed. Debug artifacts saved to: ${artifactsDir}`
          );
        }
      }
      console.error(
        '[latchkey] LATCHKEY_DEBUG=1: browser left open for inspection. Press Ctrl+C to exit.'
      );
      await new Promise(() => {
        /* hang indefinitely */
      });
    }
    throw error;
  } finally {
    await browser.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Typing delay range in milliseconds (min, max) to simulate human-like typing
const TYPING_DELAY_MIN_MS = 30;
const TYPING_DELAY_MAX_MS = 100;

/**
 * Type text character by character with random delays to simulate human typing.
 *
 * This triggers proper JavaScript input events that some websites require,
 * unlike fill() which sets the value directly.
 */
export async function typeLikeHuman(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.click();
  for (const character of text) {
    await locator.pressSequentially(character);
    const delay =
      Math.floor(Math.random() * (TYPING_DELAY_MAX_MS - TYPING_DELAY_MIN_MS + 1)) +
      TYPING_DELAY_MIN_MS;
    await page.waitForTimeout(delay);
  }
}

/** One value the user can paste back when the automation could not get it. */
export interface CredentialFormField {
  /** Key the submitted value appears under. */
  readonly name: string;
  readonly label: string;
  /** Example or explanation shown under the input. */
  readonly hint?: string;
}

interface OverlayContent {
  readonly message: string;
  readonly details: string;
  readonly showSpinner: boolean;
  readonly formFields: readonly CredentialFormField[];
}

/**
 * Script that creates the latchkey overlay, designed to run in browser context.
 *
 * The texts are injected as JSON literals and assigned as text rather than
 * markup, so an error message that happens to contain a backtick or an angle
 * bracket cannot break the script or the page.
 */
function createOverlayScript(content: OverlayContent): string {
  const { message, details, showSpinner, formFields } = content;
  return `
(() => {
  document.getElementById('latchkey-spinner-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'latchkey-spinner-overlay';
  overlay.innerHTML = \`
    <style>
      #latchkey-spinner-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #f5f5f5;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        pointer-events: none;
      }
      #latchkey-spinner-overlay .spinner {
        width: 50px;
        height: 50px;
        border: 4px solid #e0e0e0;
        border-top-color: #007bff;
        border-radius: 50%;
        animation: latchkey-spin 1s linear infinite;
      }
      #latchkey-spinner-overlay .message {
        margin-top: 20px;
        color: #555;
        font-size: 16px;
        text-align: center;
        max-width: 80%;
        white-space: pre-line;
        /* The text is there to be read from and copied (URLs, mostly), which
           needs the pointer to reach it — the overlay itself stays inert. */
        pointer-events: auto;
        user-select: text;
      }
      #latchkey-spinner-overlay .details {
        margin-top: 44px;
        color: #8a8a8a;
        font-size: 13px;
        line-height: 1.6;
        text-align: left;
        max-width: 460px;
        white-space: pre-line;
        pointer-events: auto;
        user-select: text;
      }
      #latchkey-spinner-overlay form {
        margin-top: 28px;
        width: 460px;
        max-width: 80%;
        display: flex;
        flex-direction: column;
        gap: 14px;
        pointer-events: auto;
        font-size: 13px;
        color: #555;
      }
      #latchkey-spinner-overlay form label {
        display: block;
        margin-bottom: 4px;
      }
      #latchkey-spinner-overlay form input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid #cfcfcf;
        border-radius: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        background: #fff;
      }
      #latchkey-spinner-overlay form .hint {
        margin-top: 4px;
        color: #8a8a8a;
        font-size: 12px;
      }
      #latchkey-spinner-overlay form button {
        align-self: flex-start;
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        background: #007bff;
        color: #fff;
        font-size: 13px;
        cursor: pointer;
      }
      #latchkey-spinner-overlay form button:disabled {
        background: #9dc7f5;
        cursor: default;
      }
      #latchkey-spinner-overlay .form-status {
        color: #c0392b;
        font-size: 13px;
        min-height: 18px;
        white-space: pre-line;
      }
      #latchkey-spinner-overlay .form-status.accepted {
        color: #1e7e34;
      }
      @keyframes latchkey-spin {
        to { transform: rotate(360deg); }
      }
    </style>
    ${showSpinner ? '<div class="spinner"></div>' : ''}
    <div class="message"></div>
    <div class="details"></div>
  \`;
  overlay.querySelector('.message').textContent = ${JSON.stringify(message)};
  const detailsText = ${JSON.stringify(details)};
  const detailsElement = overlay.querySelector('.details');
  if (detailsText === '') {
    detailsElement.remove();
  } else {
    detailsElement.textContent = detailsText;
  }

  const fields = ${JSON.stringify(formFields)};
  if (fields.length > 0) {
    const form = document.createElement('form');
    const inputs = fields.map((field) => {
      const wrapper = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      label.appendChild(input);
      wrapper.appendChild(label);
      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = field.hint;
        wrapper.appendChild(hint);
      }
      form.appendChild(wrapper);
      return { name: field.name, input: input };
    });

    const status = document.createElement('div');
    status.className = 'form-status';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Use these credentials';
    form.appendChild(submit);
    form.appendChild(status);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = {};
      for (const entry of inputs) {
        values[entry.name] = entry.input.value.trim();
      }
      const isComplete = inputs.every((entry) => values[entry.name] !== '');
      if (!isComplete) {
        status.textContent = 'Please fill in every field.';
        return;
      }
      status.className = 'form-status';
      status.textContent = 'Checking the credentials...';
      submit.disabled = true;
      const decision = await window['${SUBMIT_CREDENTIALS_BINDING}'](values);
      if (decision && decision.problem) {
        status.textContent = decision.problem;
        submit.disabled = false;
        return;
      }
      status.className = 'form-status accepted';
      status.textContent = 'Credentials accepted. This window can be closed.';
    });

    overlay.appendChild(form);
    setTimeout(() => { inputs[0].input.focus(); }, 0);
  }

  document.body.appendChild(overlay);
})()
`;
}

/**
 * Show a spinner overlay that hides page content from the user.
 * The overlay persists across page navigations within the browser context.
 *
 * Can be disabled by setting LATCHKEY_DISABLE_SPINNER=1 environment variable.
 *
 * Returns the spinner page so callers can later bring it back to the
 * foreground (e.g. after temporarily surfacing another page to the user),
 * or `null` when the spinner is disabled.
 *
 * The optional `details` are shown below the message in smaller, left-aligned
 * type, so longer explanations do not read like a ragged centered block.
 */
export async function showSpinnerPage(
  context: BrowserContext,
  message: string,
  details = ''
): Promise<Page | null> {
  if (process.env.LATCHKEY_DISABLE_SPINNER === '1') {
    return null;
  }
  const spinnerPage = await context.newPage();
  await spinnerPage.evaluate(
    createOverlayScript({ message, details, showSpinner: true, formFields: [] })
  );
  await spinnerPage.bringToFront();
  return spinnerPage;
}

/** Name the credential form calls to hand what the user typed back to latchkey. */
const SUBMIT_CREDENTIALS_BINDING = '__latchkeySubmitCredentials';

export class CredentialFormFieldMissingError extends Error {
  constructor(fieldName: string) {
    super(`The credential form did not provide a value for '${fieldName}'.`);
    this.name = 'CredentialFormFieldMissingError';
  }
}

/** Non-empty values the user submitted, keyed by field name. */
export class CredentialFormValues {
  private readonly values: ReadonlyMap<string, string>;

  constructor(values: ReadonlyMap<string, string>) {
    this.values = values;
  }

  get(fieldName: string): string {
    const value = this.values.get(fieldName);
    if (value === undefined) {
      throw new CredentialFormFieldMissingError(fieldName);
    }
    return value;
  }
}

/**
 * Turn what the form handed over into values, or null if it is not a complete
 * set. The form checks completeness too; this is the Node-side half of that,
 * so callers can rely on every field having a value.
 */
export function parseSubmittedCredentialValues(
  submitted: unknown,
  fields: readonly CredentialFormField[]
): CredentialFormValues | null {
  if (typeof submitted !== 'object' || submitted === null) {
    return null;
  }
  const submittedValues = submitted as Record<string, unknown>;
  const values = new Map<string, string>();
  for (const field of fields) {
    const value = submittedValues[field.name];
    if (typeof value !== 'string' || value === '') {
      return null;
    }
    values.set(field.name, value);
  }
  return new CredentialFormValues(values);
}

/** What the caller makes of a submission: a result, or a problem to report back. */
export type CredentialFormDecision<T> = { readonly accepted: T } | { readonly problem: string };

export interface CredentialRequest<T> {
  readonly context: BrowserContext;
  /**
   * Page to show the request on, typically the spinner the user has been
   * staring at. A page is opened when there is none (or it is already gone).
   */
  readonly spinnerPage: Page | null;
  readonly message: string;
  readonly details: string;
  readonly fields: readonly CredentialFormField[];
  /**
   * Decides what a submission is worth, e.g. by checking the credentials it
   * builds against the service. A returned problem is shown in the form, which
   * then lets the user correct and submit again.
   */
  readonly decide: (values: CredentialFormValues) => Promise<CredentialFormDecision<T>>;
  /** How long the request stays up before it is given up on. */
  readonly timeoutMs: number;
}

/**
 * Ask the user to paste in credentials the automation could not get, and wait
 * for them to submit something acceptable.
 *
 * Returns null when nothing usable arrived: the user closed the browser, or the
 * request timed out. There is no polling — the page calls in when the user
 * submits, and its "checking..." state is resolved by what `decide` says.
 */
export async function requestCredentialsFromUser<T>(
  request: CredentialRequest<T>
): Promise<T | null> {
  const { context, spinnerPage, message, details, fields, decide, timeoutMs } = request;
  const page =
    spinnerPage !== null && !spinnerPage.isClosed() ? spinnerPage : await context.newPage();

  let resolveAccepted: (value: T | null) => void = () => {
    /* replaced below */
  };
  const accepted = new Promise<T | null>((resolve) => {
    resolveAccepted = resolve;
  });

  // Listened for before the form goes up: a browser closed while it is being
  // rendered should end the wait just the same.
  const abandoned = new Promise<null>((resolve) => {
    const giveUp = () => {
      resolve(null);
    };
    page.on('close', giveUp);
    context.on('close', giveUp);
    context.browser()?.on('disconnected', giveUp);
  });

  await page.exposeFunction(SUBMIT_CREDENTIALS_BINDING, async (submitted: unknown) => {
    const values = parseSubmittedCredentialValues(submitted, fields);
    if (values === null) {
      return { problem: 'Please fill in every field.' };
    }
    let decision: CredentialFormDecision<T>;
    try {
      decision = await decide(values);
    } catch (error: unknown) {
      // The page is waiting for an answer, so failures are reported as
      // problems rather than left to become an unhandled rejection there.
      return { problem: error instanceof Error ? error.message : 'These values cannot be used.' };
    }
    if ('problem' in decision) {
      return { problem: decision.problem };
    }
    resolveAccepted(decision.accepted);
    return { accepted: true };
  });

  await page.evaluate(
    createOverlayScript({ message, details, showSpinner: false, formFields: fields })
  );
  await page.bringToFront();

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([accepted, abandoned, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
