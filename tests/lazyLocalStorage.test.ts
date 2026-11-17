import { EventEmitter } from 'node:events';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { BrowserStorageState } from '../src/browserStateImport.js';
import {
  mergeLazilyRestoredStorageState,
  seedLocalStorageLazily,
} from '../src/lazyLocalStorage.js';

const EXAMPLE_COM = 'https://example.com';
const EXAMPLE_ORG = 'https://example.org';

function origin(
  name: string,
  entries: Readonly<Record<string, string>>
): BrowserStorageState['origins'][number] {
  return {
    origin: name,
    localStorage: Object.entries(entries).map(([key, value]) => ({ name: key, value })),
  };
}

class FakePage extends EventEmitter {
  constructor(private currentUrl: string) {
    super();
  }

  url(): string {
    return this.currentUrl;
  }

  navigateMainFrame(url: string): void {
    this.currentUrl = url;
    this.emit('framenavigated', { parentFrame: () => null, url: () => url });
  }

  navigateChildFrame(url: string): void {
    this.emit('framenavigated', { parentFrame: () => ({}), url: () => url });
  }
}

class FakeContext extends EventEmitter {
  readonly activeScripts = new Set<string>();

  pages(): FakePage[] {
    return [];
  }

  addInitScript(script: { content: string }): Promise<{ dispose: () => Promise<void> }> {
    this.activeScripts.add(script.content);
    return Promise.resolve({
      dispose: () => {
        this.activeScripts.delete(script.content);
        return Promise.resolve();
      },
    });
  }

  requestNavigation(url: string): void {
    this.emit('request', { isNavigationRequest: () => true, url: () => url });
  }

  openPage(url: string): FakePage {
    const page = new FakePage(url);
    this.emit('page', page);
    return page;
  }
}

function startSeeding(savedOrigins: BrowserStorageState['origins']) {
  const context = new FakeContext();
  const unseededOrigins: string[] = [];
  const lazyLocalStorage = seedLocalStorageLazily(
    context as unknown as BrowserContext,
    savedOrigins,
    (unseededOrigin) => unseededOrigins.push(unseededOrigin)
  );
  return { context, unseededOrigins, lazyLocalStorage };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('seedLocalStorageLazily', () => {
  const savedOrigins = [
    origin(EXAMPLE_COM, { token: 'saved' }),
    origin(EXAMPLE_ORG, { token: 'other' }),
  ];

  it('registers nothing until a saved origin is navigated to', () => {
    const { context } = startSeeding(savedOrigins);
    context.openPage('about:blank');
    context.requestNavigation('https://unrelated.example/');

    expect(context.activeScripts.size).toBe(0);
  });

  it('registers only the seed script of the origin being navigated to', () => {
    const { context } = startSeeding(savedOrigins);
    context.openPage('about:blank');
    context.requestNavigation(`${EXAMPLE_COM}/login`);

    const scripts = [...context.activeScripts];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(JSON.stringify(EXAMPLE_COM));
    expect(scripts[0]).toContain(JSON.stringify([{ name: 'token', value: 'saved' }]));
    expect(scripts[0]).not.toContain('other');
  });

  it('removes the seed script once a page has landed on the origin', async () => {
    const { context, lazyLocalStorage, unseededOrigins } = startSeeding(savedOrigins);
    const page = context.openPage('about:blank');
    context.requestNavigation(`${EXAMPLE_COM}/login`);
    page.navigateMainFrame(`${EXAMPLE_COM}/login`);
    await flushPromises();

    expect(context.activeScripts.size).toBe(0);
    expect([...lazyLocalStorage.seededOrigins()]).toEqual([EXAMPLE_COM]);
    expect(unseededOrigins).toEqual([]);

    context.requestNavigation(`${EXAMPLE_COM}/home`);
    expect(context.activeScripts.size).toBe(0);
  });

  it('keeps the seed script while only an embedded frame is on the origin', async () => {
    const { context, lazyLocalStorage } = startSeeding(savedOrigins);
    const page = context.openPage('about:blank');
    context.requestNavigation(`${EXAMPLE_COM}/widget`);
    page.navigateChildFrame(`${EXAMPLE_COM}/widget`);
    await flushPromises();

    expect(context.activeScripts.size).toBe(1);
    expect(lazyLocalStorage.seededOrigins().size).toBe(0);
  });

  it('gives up on an origin first visited as the first document of a new page', async () => {
    const { context, lazyLocalStorage, unseededOrigins } = startSeeding(savedOrigins);
    context.requestNavigation(`${EXAMPLE_COM}/popup`);
    const popup = context.openPage(`${EXAMPLE_COM}/popup`);
    await flushPromises();

    expect(context.activeScripts.size).toBe(0);
    expect(lazyLocalStorage.seededOrigins().size).toBe(0);
    expect(unseededOrigins).toEqual([EXAMPLE_COM]);

    context.requestNavigation(`${EXAMPLE_COM}/next`);
    popup.navigateMainFrame(`${EXAMPLE_COM}/next`);
    expect(context.activeScripts.size).toBe(0);
    expect(unseededOrigins).toEqual([EXAMPLE_COM]);
  });

  it('gives up on an origin landed on without a navigation request', () => {
    const { context, lazyLocalStorage, unseededOrigins } = startSeeding(savedOrigins);
    const page = context.openPage('about:blank');
    page.navigateMainFrame(`${EXAMPLE_COM}/`);
    context.requestNavigation(`${EXAMPLE_COM}/next`);

    expect(context.activeScripts.size).toBe(0);
    expect(lazyLocalStorage.seededOrigins().size).toBe(0);
    expect(unseededOrigins).toEqual([EXAMPLE_COM]);
  });
});

describe('mergeLazilyRestoredStorageState', () => {
  const saved: BrowserStorageState = {
    cookies: [],
    origins: [
      origin(EXAMPLE_COM, { token: 'saved', other: 'kept' }),
      origin(EXAMPLE_ORG, { token: 'saved', other: 'kept' }),
    ],
  };

  it('replaces cookies with the collected ones', () => {
    const cookie: BrowserStorageState['cookies'][number] = {
      name: 'session',
      value: 'new',
      domain: 'example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    };
    const merged = mergeLazilyRestoredStorageState(
      { cookies: [{ ...cookie, name: 'gone' }], origins: [] },
      { cookies: [cookie], origins: [] },
      new Set()
    );

    expect(merged.cookies).toEqual([cookie]);
  });

  it('keeps origins the flow did not touch', () => {
    const merged = mergeLazilyRestoredStorageState(saved, { cookies: [], origins: [] }, new Set());

    expect(merged.origins).toEqual(saved.origins);
  });

  it('replaces a seeded origin with what was collected', () => {
    const merged = mergeLazilyRestoredStorageState(
      saved,
      { cookies: [], origins: [origin(EXAMPLE_COM, { token: 'rotated' })] },
      new Set([EXAMPLE_COM])
    );

    expect(merged.origins).toEqual([
      origin(EXAMPLE_ORG, { token: 'saved', other: 'kept' }),
      origin(EXAMPLE_COM, { token: 'rotated' }),
    ]);
  });

  it('drops a seeded origin the site has emptied', () => {
    const merged = mergeLazilyRestoredStorageState(
      saved,
      { cookies: [], origins: [] },
      new Set([EXAMPLE_COM])
    );

    expect(merged.origins).toEqual([origin(EXAMPLE_ORG, { token: 'saved', other: 'kept' })]);
  });

  it('keeps saved entries of an origin that was visited unseeded', () => {
    const merged = mergeLazilyRestoredStorageState(
      saved,
      { cookies: [], origins: [origin(EXAMPLE_COM, { token: 'fresh', added: 'new' })] },
      new Set()
    );

    expect(merged.origins[0]).toEqual(
      origin(EXAMPLE_COM, { token: 'fresh', other: 'kept', added: 'new' })
    );
  });

  it('adds origins that were not saved before', () => {
    const merged = mergeLazilyRestoredStorageState(
      { cookies: [], origins: [] },
      { cookies: [], origins: [origin(EXAMPLE_COM, { token: 'new' })] },
      new Set()
    );

    expect(merged.origins).toEqual([origin(EXAMPLE_COM, { token: 'new' })]);
  });
});
