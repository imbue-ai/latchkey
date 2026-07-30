/**
 * Generic browser login flows that a user-registered service can opt into.
 *
 * A built-in service implements its login in code; a registered service picks
 * one of these flows by name and supplies its parameters as JSON, so new flows
 * become available to every registered service without touching the CLI.
 */

import type { ZodType } from 'zod';
import { COOKIE_CAPTURE_LOGIN_FLOW } from './cookieCapture.js';
import { describeSchemaIssues, Service, type ServiceSession } from './base.js';

export interface LoginFlow<Params> {
  /** Value of `--login-flow`. */
  readonly name: string;
  /** One-line explanation, listed by the CLI when the flow name is wrong. */
  readonly summary: string;
  readonly paramsSchema: ZodType<Params>;
  /** Sentence describing this configuration, for `services info`. */
  describe(params: Params, loginUrl: string): string;
  createSession(service: Service, appNamePrefix: string, params: Params): ServiceSession;
}

/**
 * A login flow together with parameters already validated against its schema.
 * Only {@link resolveLoginFlow} produces these, so anything holding one can use
 * it without revalidating.
 */
export interface ResolvedLoginFlow {
  describe(loginUrl: string): string;
  createSession(service: Service, appNamePrefix: string): ServiceSession;
}

export const LOGIN_FLOWS: readonly LoginFlow<never>[] = [
  COOKIE_CAPTURE_LOGIN_FLOW as LoginFlow<never>,
];

export class UnknownLoginFlowError extends Error {
  constructor(name: string) {
    super(
      `Unknown login flow '${name}'. Available flows: ` +
        `${LOGIN_FLOWS.map((flow) => flow.name).join(', ')}.`
    );
    this.name = 'UnknownLoginFlowError';
  }
}

export class LoginFlowParamsInvalidError extends Error {
  constructor(flowName: string, detail: string) {
    super(`Invalid parameters for login flow '${flowName}': ${detail}`);
    this.name = 'LoginFlowParamsInvalidError';
  }
}

export function getLoginFlow(name: string): LoginFlow<never> | null {
  return LOGIN_FLOWS.find((flow) => flow.name === name) ?? null;
}

/**
 * Look up a flow by name and validate its parameters.
 *
 * Throws {@link UnknownLoginFlowError} or {@link LoginFlowParamsInvalidError};
 * callers decide what an unusable flow means for them (the CLI rejects the
 * registration, loading a stored service drops just the flow).
 */
export function resolveLoginFlow(name: string, params: unknown): ResolvedLoginFlow {
  const flow = getLoginFlow(name);
  if (flow === null) {
    throw new UnknownLoginFlowError(name);
  }
  const result = flow.paramsSchema.safeParse(params ?? {});
  if (!result.success) {
    throw new LoginFlowParamsInvalidError(name, describeSchemaIssues(result.error));
  }
  const validatedParams = result.data;
  return {
    describe: (loginUrl: string) => flow.describe(validatedParams, loginUrl),
    createSession: (service: Service, appNamePrefix: string) =>
      flow.createSession(service, appNamePrefix, validatedParams),
  };
}
