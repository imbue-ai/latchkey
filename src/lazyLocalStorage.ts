/**
 * Restore saved localStorage into a browser context lazily, one origin at a
 * time, as the browser flow navigates to it.
 *
 * Handing all of it to Playwright up front makes it visibly navigate a page
 * through every saved origin (and again when saving), because localStorage can
 * only be reached from a page of its own origin.
 */

import type { BrowserContext, Disposable, Frame, Page, Request } from 'playwright';
import type { BrowserStorageState } from './browserStateImport.js';

type OriginStorage = BrowserStorageState['origins'][number];

type LocalStorageEntry = OriginStorage['localStorage'][number];

export interface LazyLocalStorage {
  /** The origins whose saved localStorage has been restored so far. */
  readonly seededOrigins: () => ReadonlySet<string>;
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

/**
 * A script for the page to run before any of its own. Only top-level pages are
 * seeded: the localStorage of embedded third-party frames is partitioned and
 * is not what was saved.
 */
function buildSeedScript(origin: string, entries: readonly LocalStorageEntry[]): string {
  return `(() => {
  if (window.top !== window.self || window.location.origin !== ${JSON.stringify(origin)}) {
    return;
  }
  try {
    for (const { name, value } of ${JSON.stringify(entries)}) {
      window.localStorage.setItem(name, value);
    }
  } catch {
    // Storage that is unavailable or full is left as it is.
  }
})();`;
}

/**
 * Seed each saved origin's localStorage when the context first navigates to it.
 *
 * The seed script of an origin is registered when a navigation request to it
 * goes out, and removed once a page has landed there, so that later documents
 * of the origin keep whatever the site has stored since. Removal races the
 * browser by a local round trip: a second document of the origin that commits
 * within it is seeded again.
 *
 * Not seeded at all, and reported through `reportUnseededOrigin`, is an origin
 * first visited as the first document of a page opened by another one, or one
 * landed on without a navigation request having been seen. A document that
 * commits before its seed script is registered (a local round trip, growing
 * with the size of the origin's entries) goes unseeded without being noticed.
 */
export function seedLocalStorageLazily(
  context: BrowserContext,
  savedOrigins: readonly OriginStorage[],
  reportUnseededOrigin: (origin: string) => void
): LazyLocalStorage {
  const pendingOrigins = new Map(
    savedOrigins
      .filter((saved) => saved.localStorage.length > 0)
      .map((saved) => [saved.origin, saved.localStorage])
  );
  const registrations = new Map<string, Promise<Disposable | null>>();
  const seededOrigins = new Set<string>();

  const registerSeedScript = (request: Request): void => {
    if (!request.isNavigationRequest()) {
      return;
    }
    const origin = originOf(request.url());
    const entries = origin === null ? undefined : pendingOrigins.get(origin);
    if (origin === null || entries === undefined) {
      return;
    }
    pendingOrigins.delete(origin);
    registrations.set(
      origin,
      context.addInitScript({ content: buildSeedScript(origin, entries) }).catch(
        // The context has been closed in the meantime.
        () => null
      )
    );
  };

  const removeSeedScript = (origin: string): boolean => {
    const registration = registrations.get(origin);
    registrations.delete(origin);
    void registration
      ?.then((disposable) => disposable?.dispose())
      .catch(() => {
        // The context has been closed in the meantime.
      });
    return registration !== undefined;
  };

  const settleLandedOrigin = (url: string, isSeedable: boolean): void => {
    const origin = originOf(url);
    if (origin === null) {
      return;
    }
    // Once the site has run unseeded, seeding would overwrite what it stored.
    const wasPending = pendingOrigins.delete(origin);
    const wasRegistered = removeSeedScript(origin);
    if (wasRegistered && isSeedable) {
      seededOrigins.add(origin);
    } else if (wasRegistered || wasPending) {
      reportUnseededOrigin(origin);
    }
  };

  const watchPage = (page: Page): void => {
    // A page opened by another one (a popup, a link to a new tab) is only
    // announced once its first document is loading, which is too late for a
    // seed script to reach that document.
    settleLandedOrigin(page.url(), false);
    page.on('framenavigated', (frame: Frame) => {
      if (frame.parentFrame() === null) {
        settleLandedOrigin(frame.url(), true);
      }
    });
  };

  context.on('request', registerSeedScript);
  context.on('page', watchPage);
  context.pages().forEach(watchPage);

  return { seededOrigins: () => seededOrigins };
}

function mergeLocalStorageEntries(
  saved: readonly LocalStorageEntry[],
  collected: readonly LocalStorageEntry[]
): LocalStorageEntry[] {
  const values = new Map([...saved, ...collected].map((entry) => [entry.name, entry.value]));
  return [...values].map(([name, value]) => ({ name, value }));
}

/**
 * Combine the state saved before a browser flow with the state collected from
 * its context afterwards.
 *
 * Cookies were all restored into the context, so the collected ones replace
 * the saved ones. localStorage was only restored for the seeded origins:
 * those are replaced too (or dropped if the site emptied them), origins the
 * flow did not touch stay as saved, and an origin that was visited without
 * having been seeded keeps the saved entries the site did not set again.
 */
export function mergeLazilyRestoredStorageState(
  saved: BrowserStorageState,
  collected: BrowserStorageState,
  seededOrigins: ReadonlySet<string>
): BrowserStorageState {
  const origins = new Map(
    saved.origins
      .filter((origin) => !seededOrigins.has(origin.origin))
      .map((origin) => [origin.origin, origin])
  );
  for (const origin of collected.origins) {
    const unseeded = origins.get(origin.origin);
    origins.set(
      origin.origin,
      unseeded === undefined
        ? origin
        : {
            ...origin,
            localStorage: mergeLocalStorageEntries(unseeded.localStorage, origin.localStorage),
          }
    );
  }
  return { ...collected, origins: [...origins.values()] };
}
