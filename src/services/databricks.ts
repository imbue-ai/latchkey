/**
 * Databricks service implementation.
 *
 * Databricks uses cookie-based authentication with DBAUTH cookie and CSRF token.
 *
 * Note: The public API (`/api/2.0/`) requires Personal Access Tokens (PATs).
 * The internal API (`/ajax-api/2.0/`) works with browser session cookies,
 * which is what this implementation captures. Users should use ajax-api endpoints.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, DatabricksApiCredentials } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';

const LOGIN_DETECTION_TIMEOUT_MS = 120000;

class DatabricksServiceSession extends BrowserFollowupServiceSession {
  private csrfToken: string | null = null;

  constructor(
    service: Service,
    private readonly workspaceUrl: string
  ) {
    super(service);
  }

  onResponse(response: Response): void {
    const request = response.request();
    const url = request.url();

    // Try to capture CSRF token from API requests
    if (url.includes('.cloud.databricks.com')) {
      request
        .allHeaders()
        .then((headers) => {
          const csrf = headers['x-csrf-token'];
          if (csrf) {
            this.csrfToken = csrf;
          }
        })
        .catch(() => {
          // Ignore errors
        });
    }
  }

  protected isHeadfulLoginComplete(): boolean {
    // We use URL-based detection in waitForHeadfulLoginComplete
    return false;
  }

  /**
   * Wait for login to complete by checking the page URL.
   * Login is complete when the URL is on the workspace (not login/SSO pages).
   */
  protected override async waitForHeadfulLoginComplete(page: Page): Promise<void> {
    const workspaceHost = new URL(this.workspaceUrl).host;

    // Poll until we're on the workspace and not on a login page
    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_DETECTION_TIMEOUT_MS) {
      const url = page.url();
      const isOnWorkspace = url.includes(workspaceHost);
      const isOnLogin =
        url.includes('/login') ||
        url.includes('/oidc') ||
        url.includes('/saml') ||
        url.includes('accounts.cloud.databricks.com');

      if (isOnWorkspace && !isOnLogin) {
        // Give a moment for the page to load
        await page.waitForTimeout(2000);
        return;
      }

      await page.waitForTimeout(500);
    }

    throw new LoginFailedError('Login timed out waiting for workspace page.');
  }

  protected async performBrowserFollowup(context: BrowserContext): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    // Navigate to trigger API calls and capture CSRF token
    const responseHandler = async (response: Response): Promise<void> => {
      const request = response.request();
      try {
        const headers = await request.allHeaders();
        const csrf = headers['x-csrf-token'];
        if (csrf) {
          this.csrfToken = csrf;
        }
      } catch {
        // Ignore errors
      }
    };

    page.on('response', responseHandler);

    try {
      // Navigate to compute page to trigger API calls
      await page.goto(`${this.workspaceUrl}/compute`, {
        timeout: 30000,
        waitUntil: 'networkidle',
      });
    } catch {
      // Ignore navigation errors, we might still have captured what we need
    }

    page.off('response', responseHandler);

    // Extract all Databricks cookies from browser context
    const cookies = await context.cookies();
    const databricksCookies = cookies.filter(
      (c) => c.domain.includes('.cloud.databricks.com') || c.domain.includes('databricks.com')
    );

    if (databricksCookies.length === 0) {
      throw new LoginFailedError('Failed to find Databricks cookies. Login may have failed.');
    }

    // Check that we have DBAUTH specifically
    const hasDbAuth = databricksCookies.some((c) => c.name === 'DBAUTH');
    if (!hasDbAuth) {
      throw new LoginFailedError('Failed to find DBAUTH cookie. Login may have failed.');
    }

    // Format cookies as "name1=value1; name2=value2; ..." for curl -b
    const cookieString = databricksCookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // CSRF token might not be required for all API endpoints
    const csrfToken = this.csrfToken ?? '';

    return new DatabricksApiCredentials(cookieString, csrfToken, this.workspaceUrl);
  }
}

export class Databricks implements Service {
  readonly name = 'databricks';
  // Databricks workspace URLs vary, so we use a pattern-based approach
  readonly baseApiUrls = [] as const;
  readonly loginUrl: string;
  readonly workspaceUrl: string;

  readonly credentialCheckCurlArguments: readonly string[];

  constructor(workspaceUrl: string) {
    // Normalize workspace URL (remove trailing slash and path)
    const url = new URL(workspaceUrl);
    this.workspaceUrl = `${url.protocol}//${url.host}`;
    this.loginUrl = this.workspaceUrl;
    this.credentialCheckCurlArguments = [`${this.workspaceUrl}/api/2.0/clusters/list`];
  }

  getSession(): DatabricksServiceSession {
    return new DatabricksServiceSession(this, this.workspaceUrl);
  }

  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (!(apiCredentials instanceof DatabricksApiCredentials)) {
      return ApiCredentialStatus.Invalid;
    }

    const result = runCaptured(
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...apiCredentials.asCurlArguments(),
        ...this.credentialCheckCurlArguments,
      ],
      10
    );

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

/**
 * Check if a URL matches a Databricks workspace.
 */
export function isDatabricksUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host.endsWith('.cloud.databricks.com');
  } catch {
    return false;
  }
}

/**
 * Create a Databricks service instance for the given URL.
 */
export function createDatabricksService(url: string): Databricks {
  return new Databricks(url);
}
