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
 * Information about a single element in the DOM ancestry.
 */
export interface ElementInfo {
  /** Tag name (e.g., 'div', 'button', 'input') */
  readonly tag: string;
  /** Element's id attribute, if present */
  readonly id?: string;
  /** Element's class attribute, if present */
  readonly className?: string;
  /** Element's name attribute, if present */
  readonly name?: string;
  /** Element's role attribute or implicit ARIA role */
  readonly role?: string;
  /** Accessible name (text content, aria-label, etc.) */
  readonly accessibleName?: string;
  /** Element's type attribute (for inputs) */
  readonly inputType?: string;
  /** Element's placeholder attribute */
  readonly placeholder?: string;
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
  /** Element ancestry from target to root (first element is the target) */
  readonly ancestry?: readonly ElementInfo[];
  readonly url?: string;
  readonly value?: string;
  readonly key?: string;
  readonly timestamp: number;
}

/**
 * Result of the codegen session.
 */
export interface CodegenResult {
  /** Ancestry for the API key element, if selected by the user. */
  readonly apiKeyAncestry?: readonly ElementInfo[];
}

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenError';
  }
}
