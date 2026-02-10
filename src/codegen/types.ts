/**
 * Shared types for the codegen module.
 */

/**
 * Phase of the recording session.
 * - 'pre-login': Before the user clicks the login button
 * - 'post-login': After the user clicks the login button
 */
export type RecordingPhase = 'pre-login' | 'post-login';

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
  readonly phase: RecordingPhase;
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

/**
 * Result of the codegen session.
 */
export interface CodegenResult {
  /** Selector for the API key element, if selected by the user. */
  readonly apiKeySelector?: string;
}

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenError';
  }
}
