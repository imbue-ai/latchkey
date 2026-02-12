/**
 * Safe mathematical expression evaluation utilities.
 */

import { runInNewContext } from 'node:vm';

export class MathEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MathEvalError';
  }
}

/**
 * Safely evaluate a mathematical expression in a sandboxed VM context.
 * Returns the result as a rounded integer string.
 *
 * @param expression - Mathematical expression to evaluate (e.g., "7 + 1", "10 * 2")
 * @param timeoutMs - Timeout in milliseconds to prevent infinite loops (default: 1000)
 * @returns The result as a string, rounded to the nearest integer
 * @throws {MathEvalError} If the expression is invalid or returns a non-numeric value
 *
 * @example
 * evaluateMathExpression("7 + 1") // "8"
 * evaluateMathExpression("10 / 3") // "3" (rounds 3.333...)
 * evaluateMathExpression("2 + 3 * 4") // "14" (respects order of operations)
 */
export function evaluateMathExpression(expression: string, timeoutMs = 1000): string {
  try {
    // Evaluate in a sandboxed VM context with no access to Node.js APIs
    // Timeout prevents infinite loops
    const result: unknown = runInNewContext(expression, {}, { timeout: timeoutMs });

    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new MathEvalError(`Expression returned non-numeric value: ${String(result)}`);
    }

    return Math.round(result).toString();
  } catch (error: unknown) {
    if (error instanceof MathEvalError) {
      throw error;
    }
    throw new MathEvalError(
      `Failed to evaluate expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
