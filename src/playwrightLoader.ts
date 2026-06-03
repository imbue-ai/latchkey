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
 * The registry instance and zip `extract` function live inside
 * `lib/coreBundle`; the more specific subpaths that expose them
 * directly are absent from playwright-core's `package.json#exports`
 * map, so importing them throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
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

async function loadPlaywrightCoreBundle(): Promise<
  typeof import('playwright-core/lib/coreBundle').default
> {
  try {
    return (await import('playwright-core/lib/coreBundle')).default;
  } catch (error) {
    throw new BrowserFeaturesUnavailableError(error);
  }
}

export async function loadPlaywrightRegistry() {
  const coreBundle = await loadPlaywrightCoreBundle();
  return { registry: coreBundle.registry.registry };
}

export async function loadPlaywrightZipBundle() {
  const coreBundle = await loadPlaywrightCoreBundle();
  return { extract: coreBundle.utils.extractZip };
}
