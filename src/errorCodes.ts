/**
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
