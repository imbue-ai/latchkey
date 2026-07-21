/**
 * Centralized error messages used by both the CLI and the gateway.
 */

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
  return { commandPrefix: `--account ${account} `, serviceSuffix: ` (account '${account}')` };
}

export const ErrorMessages = {
  requestNotPermitted: 'Error: Request not permitted by the user.',
  couldNotExtractUrl:
    'Error: Could not extract URL from curl arguments. Only http(s) requests are supported.',
  couldNotExtractUrlBrief: 'Error: Could not extract URL from curl arguments.',
  upstreamRequestFailed: 'Error: Upstream request failed.',
  requestBodyTooLarge: 'Error: Request body too large.',

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
