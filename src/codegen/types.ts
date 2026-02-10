/**
 * Shared types for the codegen module.
 */

/**
 * Represents HTTP request metadata captured during recording.
 */
export interface RequestMetadata {
  readonly url: string;
  readonly method: string;
  readonly queryParams: Record<string, string>;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  readonly statusCode: number;
  readonly timestamp: string;
}

/**
 * Options for the codegen runner.
 */
export interface CodegenOptions {
  /** Path to the browser executable. */
  readonly executablePath?: string;
  /** Initial URL to navigate to. */
  readonly url?: string;
  /** Path to output the generated TypeScript code. Defaults to 'tmp.js'. */
  readonly outputFile?: string;
  /** Path to output the request metadata JSON. Defaults to 'requests.json'. */
  readonly requestsFile?: string;
}

/**
 * Represents a recorded action.
 */
export interface RecordedAction {
  readonly type:
    | 'navigate'
    | 'click'
    | 'fill'
    | 'press'
    | 'select'
    | 'check'
    | 'uncheck';
  readonly selector?: string;
  readonly url?: string;
  readonly value?: string;
  readonly key?: string;
  readonly timestamp: number;
}

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenError';
  }
}
