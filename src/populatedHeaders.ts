/**
 * Headers Latchkey can add to the curl invocation it makes, to tell whatever
 * runs as curl (see `LATCHKEY_CURL`) what Latchkey decided about the request.
 * Nothing is added unless the operator asks for a header by name, because a
 * stock curl would send it on to the third party.
 */

export const MATCHED_SERVICE_HEADER = 'X-Latchkey-Matched-Service';

/** What Latchkey knows about a request by the time it invokes curl. */
export interface PopulatedHeaderContext {
  /**
   * Name of the service whose credentials were injected, or null when the
   * request goes out without any injection.
   */
  readonly matchedServiceName: string | null;
}

interface PopulatedHeader {
  readonly name: string;
  /** Returns null when the header has no value for this request. */
  readonly resolveValue: (context: PopulatedHeaderContext) => string | null;
}

const POPULATED_HEADERS: readonly PopulatedHeader[] = [
  { name: MATCHED_SERVICE_HEADER, resolveValue: (context) => context.matchedServiceName },
];

export class UnknownPopulatedHeaderError extends Error {
  constructor(headerName: string) {
    const knownNames = POPULATED_HEADERS.map((header) => header.name).join(', ');
    super(`Latchkey cannot populate the header '${headerName}'. Known headers: ${knownNames}.`);
    this.name = 'UnknownPopulatedHeaderError';
  }
}

function findPopulatedHeader(headerName: string): PopulatedHeader | undefined {
  return POPULATED_HEADERS.find((header) => header.name.toLowerCase() === headerName.toLowerCase());
}

/**
 * Validate the requested header names and return them in canonical spelling,
 * without duplicates. Header names are case-insensitive, so the match is too.
 */
export function resolvePopulatedHeaderNames(requestedNames: readonly string[]): readonly string[] {
  const resolvedNames: string[] = [];
  for (const requestedName of requestedNames) {
    const header = findPopulatedHeader(requestedName);
    if (header === undefined) {
      throw new UnknownPopulatedHeaderError(requestedName);
    }
    if (!resolvedNames.includes(header.name)) {
      resolvedNames.push(header.name);
    }
  }
  return resolvedNames;
}

function isHeaderNamed(headerArgument: string, headerName: string): boolean {
  const separatorIndex = headerArgument.search(/[:;]/);
  if (separatorIndex === -1) {
    return false;
  }
  return headerArgument.slice(0, separatorIndex).trim().toLowerCase() === headerName.toLowerCase();
}

const ATTACHED_HEADER_FLAG_PREFIXES: readonly string[] = ['--header=', '-H'];

/**
 * Drop every header argument carrying one of the given names, in the spellings
 * `-H value`, `--header value`, `-Hvalue` and `--header=value`.
 */
function removeHeaders(
  curlArguments: readonly string[],
  headerNames: readonly string[]
): readonly string[] {
  const isRemoved = (headerArgument: string): boolean =>
    headerNames.some((headerName) => isHeaderNamed(headerArgument, headerName));
  const remaining: string[] = [];
  let index = 0;
  while (index < curlArguments.length) {
    const argument = curlArguments[index]!;
    const nextArgument = curlArguments[index + 1];
    if ((argument === '-H' || argument === '--header') && nextArgument !== undefined) {
      if (!isRemoved(nextArgument)) {
        remaining.push(argument, nextArgument);
      }
      index += 2;
      continue;
    }
    const attachedPrefix = ATTACHED_HEADER_FLAG_PREFIXES.find(
      (prefix) => argument.startsWith(prefix) && argument.length > prefix.length
    );
    if (attachedPrefix === undefined || !isRemoved(argument.slice(attachedPrefix.length))) {
      remaining.push(argument);
    }
    index += 1;
  }
  return remaining;
}

/**
 * Put the requested headers ahead of the arguments of a curl invocation.
 *
 * A copy the caller supplied is removed first, whether or not Latchkey has a
 * value of its own, so that whoever reads the header can rely on it being
 * Latchkey's statement rather than the caller's.
 */
export function populateHeadersForCurl(
  curlArguments: readonly string[],
  headerNames: readonly string[],
  context: PopulatedHeaderContext
): readonly string[] {
  if (headerNames.length === 0) {
    return curlArguments;
  }
  const populatedArguments: string[] = [];
  for (const headerName of headerNames) {
    const value = findPopulatedHeader(headerName)?.resolveValue(context) ?? null;
    if (value !== null) {
      populatedArguments.push('-H', `${headerName}: ${value}`);
    }
  }
  return [...populatedArguments, ...removeHeaders(curlArguments, headerNames)];
}
