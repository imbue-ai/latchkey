import { describe, it, expect } from 'vitest';
import { buildAuthorizationState } from '../src/services/notion-mcp.js';

describe('buildAuthorizationState', () => {
  it('puts the loopback port in the last dot-separated segment', () => {
    const state = buildAuthorizationState(54321);

    expect(state.split('.').pop()).toBe('54321');
  });

  it('prefixes the port with an unguessable value', () => {
    const state = buildAuthorizationState(54321);
    const [prefix] = state.split('.');

    // A UUID, i.e. long enough that a redirect cannot be forged by guessing.
    expect(prefix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(buildAuthorizationState(54321)).not.toBe(state);
  });
});
