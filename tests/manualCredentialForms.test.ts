/**
 * Every browser-automated service should be able to fall back on asking the
 * user for the credentials, so these tests go over the whole registry rather
 * than a single service: the forms are declarative, so they can be checked
 * without a browser.
 */

import { describe, it, expect } from 'vitest';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';
import {
  BrowserFollowupServiceSession,
  type ManualCredentialForm,
  type Service,
  type ServiceSession,
} from '../src/services/core/base.js';
import { CredentialFormValues } from '../src/playwrightUtils.js';

/**
 * Services whose login ends in an OAuth exchange (an authorization code
 * redeemed for access and refresh tokens against an app latchkey created), so
 * there is no value the user could produce by hand and paste back. Asking them
 * for one would be asking for something that does not exist.
 */
const SERVICES_WITHOUT_A_PASTEABLE_CREDENTIAL = ['dropbox'];

function isOAuthOnlyService(service: Service): boolean {
  return (
    SERVICES_WITHOUT_A_PASTEABLE_CREDENTIAL.includes(service.name) ||
    // Google's services all share one flow: latchkey prepares an OAuth client,
    // then trades a consent for tokens.
    service.name === 'google' ||
    service.name.startsWith('google-')
  );
}

interface NamedSession {
  readonly service: Service;
  readonly session: ServiceSession;
}

const BROWSER_FOLLOWUP_SESSIONS: readonly NamedSession[] = SERVICE_REGISTRY.services
  .map((service) => ({ service, session: service.getSession?.('latchkey') }))
  .filter(
    (candidate): candidate is NamedSession =>
      candidate.session instanceof BrowserFollowupServiceSession
  );

function formsWithService(): readonly { service: Service; form: ManualCredentialForm }[] {
  return BROWSER_FOLLOWUP_SESSIONS.flatMap(({ service, session }) =>
    session.manualCredentialForm === undefined
      ? []
      : [{ service, form: session.manualCredentialForm }]
  );
}

describe('manual credential forms', () => {
  it('finds the browser-automated services to check', () => {
    expect(BROWSER_FOLLOWUP_SESSIONS.length).toBeGreaterThan(5);
  });

  it.each(
    BROWSER_FOLLOWUP_SESSIONS.filter(({ service }) => !isOAuthOnlyService(service)).map(
      ({ service, session }) => ({ name: service.name, session })
    )
  )('$name offers a form for finishing the login by hand', ({ session }) => {
    expect(session.manualCredentialForm).toBeDefined();
  });

  it.each(
    formsWithService().map(({ service, form }) => ({
      name: service.name,
      displayName: service.displayName,
      form,
    }))
  )('$name asks for its credentials in a usable way', ({ displayName, form }) => {
    expect(form.instructions.length).toBeGreaterThan(30);
    expect(form.fields.length).toBeGreaterThan(0);

    const fieldNames = form.fields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    for (const field of form.fields) {
      expect(field.name).not.toBe('');
      expect(field.label).not.toBe('');
    }

    // The builder has to agree with the field names, which is the mistake this
    // catches: reading a field the form never asked for throws.
    const values = new CredentialFormValues(
      new Map(fieldNames.map((fieldName) => [fieldName, `pasted-${fieldName}`]))
    );
    const credentials = form.buildCredentials(values);
    expect(credentials.objectType).not.toBe('');

    // The instructions name the service the user is being sent to, so the page
    // does not read as if it came from nowhere.
    const firstWordOfDisplayName = displayName.split(' ')[0] ?? displayName;
    expect(form.instructions.toLowerCase()).toContain(firstWordOfDisplayName.toLowerCase());
  });
});
