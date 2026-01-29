/**
 * Type declarations for internal playwright-core modules.
 */
declare module 'playwright-core/lib/server/registry/index' {
  export function installBrowsersForNpmInstall(browsers: string[]): Promise<void>;
}
