/**
 * Machine-readable failure reporting for the CLI.
 *
 * Programs that drive latchkey as a subprocess have to tell its failure modes
 * apart. Matching on the human-readable message is brittle, so a classified
 * failure carries a stable code in two ways: a dedicated exit code, and, when
 * the LATCHKEY_ERROR_JSON environment variable is set to '1', a JSON object
 * printed on stderr after the human-readable message.
 */

export const ERROR_JSON_ENVIRONMENT_VARIABLE = 'LATCHKEY_ERROR_JSON';

/**
 * Exit code for a stored credential that no known credential schema accepts,
 * which usually means a newer latchkey wrote the store.
 */
export const INVALID_STORED_CREDENTIAL_EXIT_CODE = 3;

export interface ClassifiedFailure {
  /** Stable identifier for this failure mode; safe to dispatch on. */
  readonly code: string;
  readonly message: string;
  readonly serviceName?: string;
  readonly exitCode: number;
}

/**
 * Report a classified failure and exit. The human-readable message is printed
 * exactly as an unclassified failure would print it, so nothing changes for
 * someone reading the output.
 */
export function failWithClassifiedError(
  handlers: {
    readonly errorLog: (message: string) => void;
    readonly exit: (code: number) => never;
  },
  failure: ClassifiedFailure
): never {
  handlers.errorLog(`Error: ${failure.message}`);
  if (process.env[ERROR_JSON_ENVIRONMENT_VARIABLE] === '1') {
    handlers.errorLog(
      JSON.stringify({
        latchkeyError: {
          code: failure.code,
          message: failure.message,
          ...(failure.serviceName === undefined ? {} : { serviceName: failure.serviceName }),
        },
      })
    );
  }
  return handlers.exit(failure.exitCode);
}
