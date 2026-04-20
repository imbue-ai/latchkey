/**
 * Centralized error messages used by both the CLI and the gateway.
 */

export const ErrorMessages = {
  requestNotPermitted: 'Error: Request not permitted by the user.',
  couldNotExtractUrl:
    'Error: Could not extract URL from curl arguments. Only http(s) requests are supported.',
  couldNotExtractUrlBrief:
    'Error: Could not extract URL from curl arguments.',
  upstreamRequestFailed: 'Error: Upstream request failed.',
  requestBodyTooLarge: 'Error: Request body too large.',

  noServiceMatchesUrl(url: string): string {
    return `Error: No service matches URL: ${url}`;
  },

  noCredentialsFound(serviceName: string): string {
    return (
      `Error: No credentials found for ${serviceName}.\n` +
      `Run 'latchkey auth browser ${serviceName}' or 'latchkey auth set ${serviceName}' first.`
    );
  },

  credentialsExpired(serviceName: string): string {
    return (
      `Error: Credentials for ${serviceName} are expired.\n` +
      `Run 'latchkey auth browser ${serviceName}' or 'latchkey auth set ${serviceName}' to refresh them.`
    );
  },
} as const;
