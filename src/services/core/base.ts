/**
 * Base classes and interfaces for service implementations.
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import type { z, ZodError, ZodTypeAny } from 'zod';
import {
  ApiCredentialStatus,
  ApiCredentials,
  ApiCredentialsUsageError,
} from '../../apiCredentials/base.js';
import { DEFAULT_ACCOUNT } from '../../apiCredentials/account.js';
import { runCapturedAsync } from '../../curl.js';
import { EncryptedStorage } from '../../encryptedStorage.js';
import {
  generateLatchkeyAppName,
  requestCredentialsFromUser,
  showSpinnerPage,
  withTempBrowserContext,
  type BrowserLaunchOptions,
  type CredentialFormDecision,
  type CredentialFormField,
  type CredentialFormValues,
} from '../../playwrightUtils.js';

/**
 * Way out of a failed automation: the values the user can produce by hand and
 * paste back, and how to turn them into credentials.
 *
 * The build step only shapes the values; whether they actually work is decided
 * by the service's credential check, which runs before they are accepted.
 */
export interface ManualCredentialForm {
  /**
   * What the user can do by hand, e.g. "create a token in Settings →
   * Developer". Shown above the fields, so it should read as instructions
   * rather than as a description. Don't forget that the breakage might have
   * occurred in the middle of the process (not necessarily at the start).
   */
  readonly instructions: string;
  readonly fields: readonly CredentialFormField[];
  buildCredentials(values: CredentialFormValues): ApiCredentials;
}

/**
 * The notice explains what to do, not what went wrong: the automation's error
 * message means nothing to the user, and it is reported on the command line
 * anyway.
 */
function buildFailureNoticeDetails(form: ManualCredentialForm): string {
  return [
    form.instructions,
    'Then paste the credentials into the form below.',
    'Closing this browser window gives up on the login.',
  ].join('\n\n');
}

/** How long the browser is left open for the user to finish a failed flow. */
const MANUAL_COMPLETION_LIMIT_MS = 30 * 60_000;

export class NoCurlCredentialsNotSupportedError extends Error {
  constructor(serviceName: string) {
    super(`Service '${serviceName}' does not support set-nocurl credentials.`);
    this.name = 'NoCurlCredentialsNotSupportedError';
  }
}

export class LoginCancelledError extends Error {
  constructor(message = 'Login was cancelled because the browser was closed.') {
    super(message);
    this.name = 'LoginCancelledError';
  }
}

export class LoginFailedError extends Error {
  constructor(message = 'Login failed: no credentials were extracted.') {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/**
 * Thrown when `latchkey auth prepare` is run for a service that does not declare a
 * prepare schema (the base default — services opt in by setting one).
 */
export class PrepareNotSupportedError extends Error {
  constructor(serviceName: string) {
    super(
      `Service '${serviceName}' does not support 'latchkey auth prepare'. ` +
        `Use 'latchkey services info ${serviceName}' to see how to authenticate.`
    );
    this.name = 'PrepareNotSupportedError';
  }
}

/**
 * Thrown when the JSON passed to `latchkey auth prepare` is malformed or does not
 * match the service's prepare schema. The whole command is rejected and
 * nothing is stored.
 */
export class PrepareInputInvalidError extends Error {
  constructor(serviceName: string, detail: string) {
    super(`Invalid prepare input for '${serviceName}': ${detail}`);
    this.name = 'PrepareInputInvalidError';
  }
}

/**
 * Validate a parsed JSON value against a service's prepare schema and build the
 * resulting credentials. Centralizes validation so each service's
 * `prepareFromJson` only expresses its schema and build step. Throws
 * `PrepareInputInvalidError` (with the failing fields) on any schema mismatch;
 * nothing is built unless the input fully validates.
 */
export function buildPreparedCredentials<Schema extends ZodTypeAny>(
  serviceName: string,
  schema: Schema,
  parsedJson: unknown,
  build: (validatedInput: z.infer<Schema>) => ApiCredentials
): ApiCredentials {
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new PrepareInputInvalidError(serviceName, describeSchemaIssues(result.error));
  }
  return build(result.data as z.infer<Schema>);
}

/**
 * Render the failing fields of a schema mismatch as a single line, so every
 * command that validates JSON input reports problems the same way.
 */
export function describeSchemaIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * The outcome of a browser login or preparation flow: the extracted
 * credentials together with the account they belong to.
 *
 * The account is a string that uniquely identifies the account behind the
 * credentials (typically an e-mail, sometimes an opaque id). Because the
 * account is only known once the user has logged in, browser flows report it
 * here rather than accepting it up front. Services that cannot (yet) determine
 * the account use the default account (the empty string).
 */
export interface LoginResult {
  readonly credentials: ApiCredentials;
  readonly account: string;
}

export function isBrowserClosedError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('target closed') ||
    message.includes('browser closed') ||
    message.includes('browser has been closed') ||
    message.includes('context has been closed') ||
    message.includes('page has been closed') ||
    message.includes('net::err_aborted')
  );
}

/**
 * Detects the Playwright/CDP error raised when a response body can no longer be
 * retrieved (`Network.getResponseBody` reports "No resource with given
 * identifier found"). This happens for responses that retain no readable body —
 * redirects, evicted or cached resources, or bodies fetched after the page has
 * navigated onward. Callers that read response bodies opportunistically should
 * treat this as inconclusive rather than fatal.
 */
export function isResponseBodyUnavailableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('no resource with given identifier') ||
    message.includes('network.getresponsebody')
  );
}

export function isTimeoutError(error: Error): boolean {
  return error.name === 'TimeoutError';
}

/**
 * Abstract base class for services that latchkey can authenticate with.
 */
export abstract class Service {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly baseApiUrls: readonly (string | RegExp)[];
  abstract readonly loginUrl: string;

  /**
   * Developer notes about this service for agents and users.
   */
  abstract readonly info: string;

  /**
   * Return curl arguments for checking credentials (excluding auth headers).
   */
  abstract readonly credentialCheckCurlArguments: readonly string[];

  /**
   * Optionally transform the stored credentials before they are injected into a
   * curl call, based on the request URL. Services can override this to use a
   * different credential form for different kinds of URLs (e.g. API access vs.
   * repository access). Implementations should throw if the stored credentials
   * are not of the expected type.
   */
  adjustCredentials?(apiCredentials: ApiCredentials, url: string): ApiCredentials;

  /**
   * Check if the given API credentials are valid for this service.
   *
   * The check is a single request whose response decides validity via
   * {@link isCredentialCheckResponseValid}; services whose check endpoint
   * reports auth failures inside the body customize that hook rather than
   * this method.
   */
  async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    let allCurlArgs: readonly string[];
    try {
      allCurlArgs = await apiCredentials.injectIntoCurlCall([
        '-s',
        '-w',
        '\n%{http_code}',
        ...this.credentialCheckCurlArguments,
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return ApiCredentialStatus.Missing;
      }
      throw error;
    }

    const result = await runCapturedAsync(allCurlArgs, 10);

    // The `-w '\n%{http_code}'` above appends the status code as the final
    // line, so the body is everything before the last newline.
    const separatorIndex = result.stdout.lastIndexOf('\n');
    const httpStatusCode = result.stdout.slice(separatorIndex + 1).trim();
    const responseBody = separatorIndex === -1 ? '' : result.stdout.slice(0, separatorIndex);

    if (!this.isCredentialCheckResponseValid(httpStatusCode, responseBody)) {
      return ApiCredentialStatus.Invalid;
    }
    return ApiCredentialStatus.Valid;
  }

  /**
   * Decide whether a credential-check response indicates valid credentials.
   * The default accepts HTTP 200. Services whose check endpoint reports auth
   * failures inside the body (e.g. Slack's `ok: false`) override this.
   */
  protected isCredentialCheckResponseValid(httpStatusCode: string, _responseBody: string): boolean {
    return httpStatusCode === '200';
  }

  /**
   * Determine which account the given credentials belong to: an e-mail when
   * available, otherwise a human-readable handle, otherwise an opaque id.
   * Returns null when the account cannot be determined.
   *
   * Best-effort and entirely separate from the credential check: services
   * typically implement it via `fetchAccountFromEndpoint()`, asking an
   * identity-revealing endpoint and parsing the account from its body.
   * Services whose credentials carry no queryable identity (e.g. app-scoped
   * API keys) must still implement this — explicitly returning null — so that
   * the decision is a conscious one for every service.
   */
  abstract getAccount(apiCredentials: ApiCredentials): Promise<string | null>;

  /**
   * Return an example showing how to set credentials for this service via the CLI.
   * The service name is passed as a parameter (not baked in) so the same example
   * can be reused for aliased services in the future.
   */
  abstract setCredentialsExample(serviceName: string): string;

  /**
   * Set credentials from arbitrary (non-curl) arguments.
   * Services that support this should override to validate and return typed credentials.
   */
  getCredentialsNoCurl(_arguments: readonly string[]): ApiCredentials {
    throw new NoCurlCredentialsNotSupportedError(this.name);
  }

  /**
   * Build credentials from a parsed JSON payload for `latchkey auth prepare`.
   *
   * Optional, like `getSession`/`refreshCredentials`: services opt in by
   * implementing it (typically via `buildPreparedCredentials` with a Zod
   * schema). When a service does not implement it, prepare is "not supported"
   * — the default that lets every service stay closed until it declares a
   * schema. Implementations validate `parsedJson` and throw
   * `PrepareInputInvalidError` on mismatch.
   */
  prepareFromJson?(parsedJson: unknown): ApiCredentials;

  /**
   * Get a new session for the login flow.
   * Services that don't support browser login should not implement this method.
   * @param appNamePrefix - Prefix to use for app/project/token names created during login.
   */
  getSession?(appNamePrefix: string): ServiceSession;

  /**
   * Optional method to refresh expired credentials.
   * Services can implement this to refresh access tokens without user interaction.
   * @param apiCredentials - The expired credentials
   * @returns New credentials if refresh succeeded, null otherwise
   */
  refreshCredentials?(apiCredentials: ApiCredentials): Promise<ApiCredentials | null>;
}

/**
 * Base class for service sessions that handle browser-based interactions.
 * This includes login, preparation steps, and any other browser automation.
 */
export abstract class ServiceSession {
  readonly service: Service;
  protected readonly appNamePrefix: string;

  constructor(service: Service, appNamePrefix: string) {
    this.service = service;
    this.appNamePrefix = appNamePrefix;
  }

  /**
   * Generate a random, unique app name using the session's configured prefix.
   */
  protected generateAppName(suffix?: string): string {
    return generateLatchkeyAppName(this.appNamePrefix, suffix);
  }

  /**
   * Handle a response during the headful login phase.
   *
   * Sessions that do asynchronous work here return a promise, so that a caller
   * driving responses in on its own — replaying a recording, say — can wait for
   * one to be processed before sending the next. The login itself does not
   * wait: it polls {@link isLoginComplete} instead.
   */
  abstract onResponse(response: Response): void | Promise<void>;

  /**
   * Check if the login phase is complete.
   */
  protected abstract isLoginComplete(): boolean;

  /**
   * Finalize credentials after the headful login phase.
   * Receives the browser and context from the login phase, which are still open.
   * @param browser - Browser instance
   * @param context - Browser context
   * @param oldCredentials - Optional existing credentials to reuse
   */
  protected abstract finalizeCredentials(
    browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null>;

  /**
   * Wait until the browser login phase is complete.
   */
  private async waitForLoginComplete(page: Page): Promise<void> {
    while (!this.isLoginComplete()) {
      await page.waitForTimeout(100);
    }
  }

  /**
   * Page hiding the automation from the user, for sessions that show one, or
   * null while none is up (or when the spinner is disabled). It doubles as the
   * place where a failure is explained to the user.
   *
   * Subclasses that temporarily surface a real page to the user (e.g. to have
   * terms accepted) bring this page back to the front afterwards.
   */
  protected spinnerPage: Page | null = null;

  /**
   * Form shown on the failure notice for the user to paste the credentials they
   * created by hand into.
   */
  protected readonly manualCredentialForm?: ManualCredentialForm;

  /**
   * Turn a failed finalization into an error the user can act on, without
   * taking the browser away from them.
   *
   * A broken automation usually means the service changed, which is precisely
   * the situation where the flow is still perfectly doable by hand: the browser
   * is signed in and sitting on the right page. So the spinner is replaced by
   * an explanation of what failed and what to do about it, and the window stays
   * open for a while, waiting for the user to paste the credentials in.
   *
   * This needs somewhere to put them, so sessions without a
   * {@link manualCredentialForm} report the failure straight away rather than
   * asking for work latchkey could not accept.
   */
  private async recoverFromFinalizationFailure(
    context: BrowserContext,
    error: Error
  ): Promise<ApiCredentials> {
    // A timeout says nothing beyond "the page did not do what we expected", so
    // it is reported as the login failure it is.
    const failure = isTimeoutError(error)
      ? new LoginFailedError(`Login failed: ${error.message}`)
      : error;

    const form = this.manualCredentialForm;
    if (form === undefined) {
      throw failure;
    }

    console.error(
      `[latchkey] The ${this.service.displayName} login automation failed. The browser ` +
        'window is left open so the credentials can be provided by hand; close it to give up.'
    );

    let credentials: ApiCredentials | null;
    try {
      credentials = await requestCredentialsFromUser<ApiCredentials>({
        context,
        spinnerPage: this.spinnerPage,
        message: `Latchkey could not finish the ${this.service.displayName} login automatically.`,
        details: buildFailureNoticeDetails(form),
        fields: form.fields,
        decide: (values) => this.decideOnSubmittedCredentials(form, values),
        timeoutMs: MANUAL_COMPLETION_LIMIT_MS,
      });
    } catch {
      // The browser is gone; there is nobody left to ask.
      throw failure;
    }

    if (credentials !== null) {
      return credentials;
    }
    // Nothing came of the request, so the automation failure is what gets reported.
    throw failure;
  }

  /**
   * Turn submitted values into credentials, refusing them with a reason the form
   * can show if the service does not accept them.
   */
  private async decideOnSubmittedCredentials(
    form: ManualCredentialForm,
    values: CredentialFormValues
  ): Promise<CredentialFormDecision<ApiCredentials>> {
    // A build error is reported to the user as a problem with what they typed:
    // requestCredentialsFromUser turns it into one.
    const credentials = form.buildCredentials(values);

    // These were pasted by hand, so they are checked before being taken:
    // finding out now beats storing a typo and failing on the next request.
    const status = await this.service.checkApiCredentials(credentials);
    if (status !== ApiCredentialStatus.Valid) {
      return {
        problem:
          `${this.service.displayName} did not accept these credentials (${status}). ` +
          'Please check them and try again.',
      };
    }
    return { accepted: credentials };
  }

  /**
   * Optional preparation step before login.
   * Services can override this to perform setup (e.g., creating OAuth clients).
   *
   * Unlike {@link login}, this returns bare credentials without an account:
   * preparations are service-level artifacts shared by all of a service's
   * accounts, and usually happen before any user is signed in.
   */
  prepare?(
    encryptedStorage: EncryptedStorage,
    launchOptions?: BrowserLaunchOptions
  ): Promise<ApiCredentials>;

  /**
   * Perform the login flow and return the extracted credentials.
   * @param encryptedStorage - Storage for managing credentials
   * @param launchOptions - Browser launch options
   * @param oldCredentials - Optional existing credentials to reuse (e.g., client ID/secret)
   */
  async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {},
    oldCredentials?: ApiCredentials
  ): Promise<LoginResult> {
    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ browser, context }) => {
      const page = await context.newPage();

      context.on('response', (response) => {
        void this.onResponse(response);
      });

      try {
        await page.goto(this.service.loginUrl);
        await this.waitForLoginComplete(page);
      } catch (error: unknown) {
        if (error instanceof Error && isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        throw error;
      }

      let apiCredentials: ApiCredentials | null;
      try {
        apiCredentials = await this.finalizeCredentials(browser, context, oldCredentials);
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw error;
        }
        if (isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        apiCredentials = await this.recoverFromFinalizationFailure(context, error);
      }

      if (apiCredentials === null) {
        throw new LoginFailedError();
      }

      // Ask the service which account the fresh credentials belong to,
      // falling back to the unnamed default account.
      const account = (await this.service.getAccount(apiCredentials)) ?? DEFAULT_ACCOUNT;
      return { credentials: apiCredentials, account };
    });
  }
}

/**
 * Simple service session where credentials are extracted by observing requests during login.
 */
export abstract class SimpleServiceSession extends ServiceSession {
  protected apiCredentials: ApiCredentials | null = null;

  /**
   * What the session has extracted so far, or null while the login phase is
   * still going.
   *
   * Exists for the tests, and they are its only callers: a real login goes
   * through {@link login}, which returns the credentials once the phase
   * completes. It is public rather than protected because the alternative is
   * what the tests did before — casting past `protected` to read the field —
   * which typechecks forever and quietly stops meaning anything the moment the
   * internals change.
   */
  get capturedCredentials(): ApiCredentials | null {
    return this.apiCredentials;
  }

  /**
   * Extract API credentials from a response during the headful login phase.
   */
  protected abstract getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null>;

  onResponse(response: Response): Promise<void> {
    if (this.apiCredentials !== null) {
      return Promise.resolve();
    }
    return this.getApiCredentialsFromResponse(response)
      .then((credentials) => {
        // Another response may have produced credentials while this one was
        // being read.
        if (this.apiCredentials === null && credentials !== null) {
          this.apiCredentials = credentials;
        }
      })
      .catch(() => {
        // Ignore errors extracting credentials
      });
  }

  protected isLoginComplete(): boolean {
    return this.apiCredentials !== null;
  }

  protected finalizeCredentials(
    _browser: Browser,
    _context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    return Promise.resolve(this.apiCredentials);
  }
}

/**
 * What the browser followup does in the user's account, phrased for users who
 * do not care about the underlying mechanism (e.g. "app" rather than "OAuth
 * client", which is also what service consoles like Dropbox's call it).
 *
 * Each value ends with the preposition that links it to "your <service>
 * account", since retrieval and creation need different ones.
 */
export enum FollowupWork {
  CreateApiToken = 'Creating an API token in',
  CreateApp = 'Creating an app in',
  RetrieveApiToken = 'Retrieving the API token from',
}

/**
 * Build the small print shown below the spinner headline: what the automation
 * is doing and how to recover when it fails.
 */
export function buildFollowupSpinnerDetails(
  displayName: string,
  followupWork: FollowupWork,
  durationSentence = 'This can take a while.'
): string {
  return (
    `${followupWork} your ${displayName} account. ${durationSentence} ` +
    'If the process fails, click the first browser tab in this window to manually complete it.'
  );
}

/**
 * Service session that requires a browser followup to finalize credentials.
 *
 * The login phase captures login state. After login completes,
 * the same browser session is reused to perform additional actions
 * (e.g., navigating to settings and creating an API key).
 */
export abstract class BrowserFollowupServiceSession extends ServiceSession {
  /** What the followup does in the user's account, shown on the spinner page. */
  protected abstract readonly followupWork: FollowupWork;

  /**
   * Perform actions in the browser to finalize and extract API credentials.
   * This runs in the same browser session used for login.
   * @param context - Browser context
   * @param oldCredentials - Optional existing credentials to reuse
   */
  protected abstract performBrowserFollowup(
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null>;

  protected override async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    this.spinnerPage = await showSpinnerPage(
      context,
      `Finalizing ${this.service.displayName} login...`,
      buildFollowupSpinnerDetails(this.service.displayName, this.followupWork)
    );
    return this.performBrowserFollowup(context, oldCredentials);
  }
}
