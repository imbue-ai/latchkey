/**
 * Centralized error messages and error codes used by both the CLI and the gateway.
 */

/**
 * Characters that need no shell quoting. Ordinary accounts (e-mails, opaque
 * ids) consist only of these, so the common suggestion stays unquoted and
 * reads the way a user would type it.
 */
const SHELL_SAFE_ACCOUNT_PATTERN = /^[A-Za-z0-9@._:+/=,-]+$/;

/**
 * Characters that a double-quoted shell word still interprets.
 */
const DOUBLE_QUOTE_UNSAFE_PATTERN = /["$`\\]/;

/**
 * Quote an account so a suggested command can be pasted into a shell verbatim.
 * Account names routinely contain spaces and apostrophes — a Notion account
 * looks like `jane@example.com:Jane's Space` — and an unquoted suggestion
 * would be re-split by the shell into something that could never match.
 *
 * Double quotes are preferred over single ones because the suggestions
 * themselves are wrapped in single quotes in prose, where a nested `'...'`
 * would be unreadable. Only a name containing a character that survives inside
 * double quotes falls back to single-quoting (escaping any apostrophe the
 * shell way, as `'\''`).
 */
function shellQuoteAccount(value: string): string {
  if (SHELL_SAFE_ACCOUNT_PATTERN.test(value)) {
    return value;
  }
  if (!DOUBLE_QUOTE_UNSAFE_PATTERN.test(value)) {
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Pieces used to mention a specific account in credential error messages: a
 * `--account` prefix for suggested commands and a suffix naming the account.
 * Both are empty when no account was explicitly requested (or it is the
 * default, unnamed account).
 */
function accountMessageParts(account: string | undefined): {
  commandPrefix: string;
  serviceSuffix: string;
} {
  if (account === undefined || account === '') {
    return { commandPrefix: '', serviceSuffix: '' };
  }
  return {
    commandPrefix: `--account ${shellQuoteAccount(account)} `,
    serviceSuffix: ` (account '${account}')`,
  };
}

export const ErrorMessages = {
  requestNotPermitted: 'Error: Request not permitted.',
  couldNotExtractUrl:
    'Error: Could not extract URL from curl arguments. Only http(s) requests are supported.',
  couldNotExtractUrlBrief: 'Error: Could not extract URL from curl arguments.',
  upstreamRequestFailed: 'Error: Upstream request failed.',
  requestBodyTooLarge: 'Error: Request body too large.',
  noCredentialsRequestsNotAllowed:
    'Error: Forwarding requests without credential injection is not enabled on this gateway. ' +
    'Set LATCHKEY_PASSTHROUGH_UNKNOWN to allow it.',

  noServiceMatchesUrl(url: string): string {
    return `Error: No service matches URL: ${url}`;
  },

  noCredentialsFound(serviceName: string, account?: string): string {
    const { commandPrefix, serviceSuffix } = accountMessageParts(account);
    return (
      `Error: No credentials found for ${serviceName}${serviceSuffix}.\n` +
      `Run 'latchkey ${commandPrefix}auth browser ${serviceName}' or ` +
      `'latchkey ${commandPrefix}auth set ${serviceName}' first.`
    );
  },

  credentialsExpired(serviceName: string, account?: string): string {
    const { commandPrefix, serviceSuffix } = accountMessageParts(account);
    return (
      `Error: Credentials for ${serviceName}${serviceSuffix} are expired.\n` +
      `Run 'latchkey ${commandPrefix}auth browser ${serviceName}' or ` +
      `'latchkey ${commandPrefix}auth set ${serviceName}' to refresh them.`
    );
  },
} as const;

/**
 * Error codes.
 *
 * Errors the CLI reports on stderr as a single line of JSON, of the form
 * `{"errorCode": "...", "errorMessage": "..."}`, so that applications wrapping
 * Latchkey can tell them apart without parsing prose.
 *
 * This is the one place where error codes are defined. For now only the errors
 * listed here are reported this way; eventually all CLI errors should get a
 * code and be reported in this form instead of as plain text.
 */
export const ErrorCodes = {
  /**
   * The Google Chrome profile exists but its files could not be read. On macOS
   * this means the application running Latchkey lacks Full Disk Access.
   */
  chromeProfileNotReadable: 'CHROME_PROFILE_NOT_READABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export abstract class CodedError extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function formatCodedErrorAsJson(error: CodedError): string {
  return JSON.stringify({ errorCode: error.errorCode, errorMessage: error.message });
}
