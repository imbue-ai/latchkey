/**
 * Lazy loaders for the `playwright` and `playwright-core` packages.
 *
 * The single-file binary produced by `bun build --compile` marks these
 * packages as external, so they cannot be bundled. Code paths that need
 * browser functionality must obtain the modules through these helpers,
 * which surface a clear, actionable error when the modules cannot be
 * resolved at runtime (i.e. when a user is running the standalone binary
 * instead of the `npm install -g latchkey` distribution).
 *
 * Playwright-core 1.60 restructured its internals: the symbols we used
 * to import from ``lib/server/registry/index`` (the ``registry``
 * instance) and ``lib/zipBundle`` (the ``extract`` function) now live
 * inside ``lib/coreBundle`` as ``coreBundle.default.registry.registry``
 * and ``coreBundle.default.utils.extractZip``. The old subpaths are no
 * longer in playwright-core's ``package.json#exports`` map, so any
 * import that names them throws ``ERR_PACKAGE_PATH_NOT_EXPORTED`` —
 * which our caller surfaces as ``BrowserFeaturesUnavailableError`` and
 * the user sees as "Browser-based features are not available in the
 * standalone latchkey binary" even though both ``playwright`` and
 * ``playwright-core`` resolve fine. Loading via ``lib/coreBundle``
 * (which IS in the exports map) and adapting the returned namespace
 * keeps the original ``{ registry }`` / ``{ extract }`` shape that
 * playwrightDownload.ts destructures.
 */

export class BrowserFeaturesUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'Browser-based features are not available in the standalone latchkey ' +
        'binary. Install the full version via `npm install -g latchkey` to ' +
        'use `latchkey auth browser`, `latchkey ensure-browser`, and ' +
        'browser-based service logins.'
    );
    this.name = 'BrowserFeaturesUnavailableError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch (error) {
    throw new BrowserFeaturesUnavailableError(error);
  }
}

interface PlaywrightExecutable {
  name: string;
  directory?: string;
  executablePath(sdkLanguage: string): string | undefined;
  downloadURLs?: string[];
}

interface PlaywrightRegistry {
  findExecutable(name: string): PlaywrightExecutable | undefined;
}

interface PlaywrightCoreBundle {
  default: {
    registry: {
      registry: PlaywrightRegistry;
    };
    utils: {
      extractZip: (zipPath: string, options: { dir: string }) => Promise<void>;
    };
  };
}

async function loadPlaywrightCoreBundle(): Promise<PlaywrightCoreBundle> {
  try {
    return (await import('playwright-core/lib/coreBundle')) as unknown as PlaywrightCoreBundle;
  } catch (error) {
    throw new BrowserFeaturesUnavailableError(error);
  }
}

export async function loadPlaywrightRegistry(): Promise<{ registry: PlaywrightRegistry }> {
  const cb = await loadPlaywrightCoreBundle();
  return { registry: cb.default.registry.registry };
}

export async function loadPlaywrightZipBundle(): Promise<{
  extract: (zipPath: string, options: { dir: string }) => Promise<void>;
}> {
  const cb = await loadPlaywrightCoreBundle();
  return { extract: cb.default.utils.extractZip };
}
