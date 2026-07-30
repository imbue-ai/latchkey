/**
 * Generic browser login flows that a user-registered service can opt into.
 *
 * A built-in service implements its login in code; a registered service picks
 * one of these flows by name and supplies its parameters as JSON, so new flows
 * become available to every registered service without touching the CLI.
 *
 * Three things are involved, and they are deliberately distinct:
 *
 * - a **flow class** is a kind of automation, with a name and a parameter
 *   schema — {@link LoginFlowClass};
 * - a **flow** is one configuration of that kind, holding validated parameters
 *   and able to create sessions — {@link LoginFlow};
 * - a **session** is a single run of one, created per login and discarded
 *   afterwards — `ServiceSession`.
 *
 * The parameters are validated long before a login happens (when a service is
 * registered, or when config.json is read), which is why a flow rather than a
 * session is what a registered service holds on to.
 */

import type { ZodType } from 'zod';
import { CookieCaptureLoginFlow } from './cookieCapture.js';
import { describeSchemaIssues, Service, type ServiceSession } from './base.js';

/**
 * A login flow configured with validated parameters: what a registered service
 * keeps, and what creates a session each time the user logs in.
 */
export interface LoginFlow {
  /** Sentence describing this configuration, for `services info`. */
  describe(loginUrl: string): string;
  createSession(service: Service, appNamePrefix: string): ServiceSession;
}

/**
 * The static side of a flow class: a kind of login flow, before anyone has
 * configured it. Instances are the configured flows.
 *
 * This lives here rather than on the class because statics cannot refer to a
 * class's own type parameters, so the parameter type has to be expressed by
 * the type the class is checked against.
 */
export interface LoginFlowClass<Params> {
  new (params: Params): LoginFlow;
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  readonly flowName: string;
  /** One-line explanation, listed by the CLI when the flow name is wrong. */
  readonly summary: string;
  /**
   * The flow's reference documentation — its parameters, its caveats and an
   * example — shown by `latchkey services register --help`. Written unindented
   * and in whole lines; {@link formatLoginFlowsHelp} indents it.
   */
  readonly details: string;
  readonly paramsSchema: ZodType<Params>;
}

/**
 * A flow class as the registry holds it, with its parameter type erased. The
 * CLI and the config loader deal in flows generically; only `configure` still
 * knows what shape this particular flow's parameters have.
 */
export interface LoginFlowRegistration {
  readonly name: string;
  readonly summary: string;
  readonly details: string;
  /** Validate parameters and configure the flow with them. */
  configure(params: unknown): LoginFlow;
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
 * Register a flow class, erasing its parameter type. Inference ties the schema
 * to the constructor, so a class whose schema disagrees with the parameters it
 * accepts does not compile.
 */
export function defineLoginFlow<Params>(flowClass: LoginFlowClass<Params>): LoginFlowRegistration {
  return {
    name: flowClass.flowName,
    summary: flowClass.summary,
    details: flowClass.details,
    configure(params: unknown): LoginFlow {
      const result = flowClass.paramsSchema.safeParse(params ?? {});
      if (!result.success) {
        throw new LoginFlowParamsInvalidError(
          flowClass.flowName,
          describeSchemaIssues(result.error)
        );
      }
      return new flowClass(result.data);
    },
  };
}

export const LOGIN_FLOWS: readonly LoginFlowRegistration[] = [
  defineLoginFlow(CookieCaptureLoginFlow),
];

export function getLoginFlow(name: string): LoginFlowRegistration | null {
  return LOGIN_FLOWS.find((flow) => flow.name === name) ?? null;
}

/**
 * Look up a flow class by name and configure it with the given parameters.
 *
 * Throws {@link UnknownLoginFlowError} or {@link LoginFlowParamsInvalidError};
 * callers decide what an unusable flow means for them (the CLI rejects the
 * registration, loading a stored service drops just the flow).
 */
export function resolveLoginFlow(name: string, params: unknown): LoginFlow {
  const registration = getLoginFlow(name);
  if (registration === null) {
    throw new UnknownLoginFlowError(name);
  }
  return registration.configure(params);
}

function indent(text: string, spaces: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `${spaces}${line}`))
    .join('\n');
}

/**
 * The reference documentation for every registered flow, for
 * `latchkey services register --help`. Generated from the registry, so a flow
 * added later documents itself without the CLI knowing anything about it.
 */
export function formatLoginFlowsHelp(): string {
  const sections = LOGIN_FLOWS.map(
    (flow) => `  ${flow.name}\n${indent(flow.summary, '    ')}\n\n${indent(flow.details, '    ')}`
  );
  return [
    'Login flows:',
    '  A service registered without --service-family can be given one of the',
    '  generic browser logins below, through --login-flow together with the',
    "  flow's parameters as a JSON object in --login-flow-params. Both need",
    '  --login-url, the page the flow starts from.',
    '',
    ...sections,
  ].join('\n');
}
