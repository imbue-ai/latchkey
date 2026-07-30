/**
 * The list of generic browser login flows, and looking one up by the name
 * `--login-flow` takes.
 *
 * This is the only module that knows which flows exist. What a flow *is* lives
 * in `loginFlow`, which the flows themselves import; keeping the list separate
 * is what stops that from being a cycle.
 */

import { CookieCaptureLoginFlow } from './cookieCapture.js';
import type { LoginFlow, LoginFlowClass } from './loginFlow.js';

export const LOGIN_FLOWS: readonly LoginFlowClass[] = [CookieCaptureLoginFlow];

export class UnknownLoginFlowError extends Error {
  constructor(name: string) {
    super(
      `Unknown login flow '${name}'. Available flows: ` +
        `${LOGIN_FLOWS.map((flowClass) => flowClass.flowName).join(', ')}.`
    );
    this.name = 'UnknownLoginFlowError';
  }
}

export function getLoginFlow(name: string): LoginFlowClass | null {
  return LOGIN_FLOWS.find((flowClass) => flowClass.flowName === name) ?? null;
}

/**
 * Look up a flow class by name and configure it with the given parameters.
 *
 * Throws {@link UnknownLoginFlowError}, or `LoginFlowParamsInvalidError` from
 * the flow's own validation; callers decide what an unusable flow means for
 * them (the CLI rejects the registration, loading a stored service drops just
 * the flow).
 */
export function resolveLoginFlow(name: string, params: unknown): LoginFlow {
  const flowClass = getLoginFlow(name);
  if (flowClass === null) {
    throw new UnknownLoginFlowError(name);
  }
  return new flowClass(params);
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
    (flowClass) =>
      `  ${flowClass.flowName}\n${indent(flowClass.summary, '    ')}\n\n` +
      indent(flowClass.details, '    ')
  );
  return [
    'Login flows:',
    '  Each login flow is configured by a JSON object supplied by',
    '  --login-flow-params.',
    '',
    ...sections,
  ].join('\n');
}
