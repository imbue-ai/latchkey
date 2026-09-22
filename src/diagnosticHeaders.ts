/**
 * Headers Latchkey can add to the curl invocation it makes, to
 * help downstream consumers understand Latchkey's behavior.
 */

export const MATCHED_SERVICE_HEADER = 'X-Latchkey-Matched-Service';

/** What Latchkey knows about a request by the time it invokes curl. */
export interface DiagnosticHeaderContext {
  /**
   * Name of the service whose credentials were injected, or null when the
   * request goes out without any injection.
   */
  readonly matchedServiceName: string | null;
}

interface DiagnosticHeader {
  readonly name: string;
  /** Returns null when the header has no value for this request. */
  readonly resolveValue: (context: DiagnosticHeaderContext) => string | null;
}

const DIAGNOSTIC_HEADERS: readonly DiagnosticHeader[] = [
  { name: MATCHED_SERVICE_HEADER, resolveValue: (context) => context.matchedServiceName },
];

/**
 * Put the diagnostic headers ahead of the arguments of a curl invocation, so
 * they come before any header of the same name the caller supplied.
 */
export function addDiagnosticHeaders(
  curlArguments: readonly string[],
  context: DiagnosticHeaderContext
): readonly string[] {
  const headerArguments = DIAGNOSTIC_HEADERS.flatMap((header) => {
    const value = header.resolveValue(context);
    return value === null ? [] : ['-H', `${header.name}: ${value}`];
  });
  return [...headerArguments, ...curlArguments];
}
