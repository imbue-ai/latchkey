/**
 * Shared types for the codegen module.
 */

/**
 * Phase of the recording session.
 * - 'pre-login': Before the user indicates they will log in
 * - 'logging-in': After indicating login intent, during authentication process
 * - 'post-login': After the user confirms they have successfully logged in
 */
export type RecordingPhase = 'pre-login' | 'logging-in' | 'post-login';

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
 * Selector variant for code generation.
 * Multiple variants are generated for AI post-processing to pick the best one.
 */
export interface SelectorVariant {
  readonly type: 'id' | 'class' | 'label' | 'testid' | 'fallback';
  readonly selector: string;
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
  /** Primary selector (for backwards compatibility) */
  readonly selector?: string;
  /** All available selector variants for this action */
  readonly selectorVariants?: readonly SelectorVariant[];
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
