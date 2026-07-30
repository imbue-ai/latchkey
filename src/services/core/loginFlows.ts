/**
 * Generic browser login flows that a user-registered service can opt into.
 *
 * A built-in service implements its login in code; a registered service picks
 * one of these flows by name and supplies its parameters as JSON, so new flows
 * become available to every registered service without touching the CLI.
 */

import type { ZodType } from 'zod';
import { CookieCaptureServiceSession } from './cookieCapture.js';
import { describeSchemaIssues, Service, type ServiceSession } from './base.js';

/**
 * A login flow is defined by its session class: the name, the parameter schema
 * and the description are statics next to the implementation they describe.
 *
 * This is that static side. It lives here rather than on the class because
 * statics cannot refer to a class's own type parameters, so the parameter type
 * has to be expressed by the type the class is checked against.
 */
export interface LoginFlowClass<Params> {
  new (service: Service, appNamePrefix: string, params: Params): ServiceSession;
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  readonly flowName: string;
  /** One-line explanation, listed by the CLI when the flow name is wrong. */
  readonly summary: string;
  readonly paramsSchema: ZodType<Params>;
  /** Sentence describing one configuration of this flow, for `services info`. */
  describe(params: Params, loginUrl: string): string;
}

/**
 * A flow as the registry holds it, with its parameter type erased. The CLI and
 * the config loader deal in flows generically; only `resolve` still knows what
 * shape this particular flow's parameters have.
 */
export interface LoginFlow {
  readonly name: string;
  readonly summary: string;
  /** Validate parameters for this flow. Throws {@link LoginFlowParamsInvalidError}. */
  resolve(params: unknown): ResolvedLoginFlow;
}

/**
 * A flow whose parameters have been validated, ready to be used without
 * knowing (or revalidating) their type. Closing over the parameters is what
 * erases them: everything that needs them is applied here.
 */
export interface ResolvedLoginFlow {
  describe(loginUrl: string): string;
  createSession(service: Service, appNamePrefix: string): ServiceSession;
}

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

/**
 * Register a flow class, erasing its parameter type. Inference ties the schema,
 * the description and the constructor to one parameter type, so a class whose
 * statics disagree with its constructor does not compile.
 */
export function defineLoginFlow<Params>(flowClass: LoginFlowClass<Params>): LoginFlow {
  return {
    name: flowClass.flowName,
    summary: flowClass.summary,
    resolve(params: unknown): ResolvedLoginFlow {
      const result = flowClass.paramsSchema.safeParse(params ?? {});
      if (!result.success) {
        throw new LoginFlowParamsInvalidError(
          flowClass.flowName,
          describeSchemaIssues(result.error)
        );
      }
      const validatedParams = result.data;
      return {
        describe: (loginUrl: string) => flowClass.describe(validatedParams, loginUrl),
        createSession: (service: Service, appNamePrefix: string) =>
          new flowClass(service, appNamePrefix, validatedParams),
      };
    },
  };
}

export const LOGIN_FLOWS: readonly LoginFlow[] = [defineLoginFlow(CookieCaptureServiceSession)];

export function getLoginFlow(name: string): LoginFlow | null {
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
  return flow.resolve(params);
}
