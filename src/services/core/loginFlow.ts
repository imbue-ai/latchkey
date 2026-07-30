/**
 * What a generic browser login flow is, and how its parameters are read.
 *
 * A built-in service implements its login in code. A registered service picks a
 * flow by name and supplies parameters as JSON, so new flows become available to
 * every registered service without the CLI knowing anything about them.
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
 *
 * The flows themselves are listed in `loginFlowRegistry`, which imports them.
 * Keeping that list out of this module is what lets a flow import from here
 * without the two forming a cycle.
 */

import type { ZodType, ZodTypeAny } from 'zod';
import { describeSchemaIssues, Service, type ServiceSession } from './base.js';

/**
 * Thrown when the parameters stored for a login flow do not match its schema.
 */
export class LoginFlowParamsInvalidError extends Error {
  constructor(flowName: string, detail: string) {
    super(`Invalid parameters for login flow '${flowName}': ${detail}`);
    this.name = 'LoginFlowParamsInvalidError';
  }
}

/**
 * A generic browser login that a user-registered service can opt into,
 * configured with the parameters that service was registered with.
 *
 * A built-in service implements its login in code. A registered service picks a
 * flow by name and supplies parameters as JSON, so new flows become available to
 * every registered service without the CLI knowing anything about them.
 */
export interface LoginFlow {
  /** Sentence describing this configuration, for `services info`. */
  describe(loginUrl: string): string;
  createSession(service: Service, appNamePrefix: string): ServiceSession;
}

/**
 * The class side of a flow: the kind of automation, before anyone configures
 * it. Its instances are the configured flows.
 *
 * The metadata has to be static, since flows are listed and described before
 * any parameters exist — and TypeScript has no `abstract static`, so this
 * interface is what holds a flow class to declaring it. A flow states the
 * obligation with `satisfies LoginFlowClass`; the registry checks it again by
 * being typed as an array of these.
 */
export interface LoginFlowClass {
  new (params: unknown): LoginFlow;
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  readonly flowName: string;
  /** One-line explanation, listed by the CLI when the flow name is wrong. */
  readonly summary: string;
  /** Reference documentation, shown by `services register --help`. */
  readonly details: string;
  readonly paramsSchema: ZodTypeAny;
}

/**
 * Validate the parameters a flow was registered with, against the flow's own
 * schema. Inference gives back the schema's type, so a flow storing the result
 * cannot disagree with the schema it declared.
 */
export function parseLoginFlowParams<Params>(
  flowClass: { readonly flowName: string; readonly paramsSchema: ZodType<Params> },
  rawParams: unknown
): Params {
  const result = flowClass.paramsSchema.safeParse(rawParams ?? {});
  if (!result.success) {
    throw new LoginFlowParamsInvalidError(flowClass.flowName, describeSchemaIssues(result.error));
  }
  return result.data;
}
