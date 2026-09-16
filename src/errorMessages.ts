/**
 * Centralized error messages used by both the CLI and the gateway.
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
  requestNotPermitted: 'Error: Request not permitted by the user.',
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
