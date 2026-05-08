#!/usr/bin/env npx tsx
/**
 * Dev tool: launch a real Chrome with latchkey's stored Google session,
 * navigate to a URL, optionally run a JS expression on the page, and dump
 * accessibility snapshot / HTML / screenshot to /tmp.
 *
 * Used to interactively figure out selectors for new prepare-flow steps
 * without recreating GCP projects.
 *
 * Usage:
 *   npx tsx scripts/devInspectPage.ts --url=<url> [--eval=<js>] [--keep-open]
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'playwright';
import { CONFIG } from '../src/config.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { resolveEncryptionKey } from '../src/encryption.js';
import { loadPlaywright } from '../src/playwrightLoader.js';

interface Args {
  url: string;
  evalExpr?: string;
  keepOpen: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let url: string | undefined;
  let evalExpr: string | undefined;
  let keepOpen = false;
  for (const arg of args) {
    if (arg.startsWith('--url=')) url = arg.slice('--url='.length);
    else if (arg.startsWith('--eval=')) evalExpr = arg.slice('--eval='.length);
    else if (arg === '--keep-open') keepOpen = true;
  }
  if (!url) {
    console.error('Usage: devInspectPage.ts --url=<url> [--eval=<js>] [--keep-open]');
    process.exit(1);
  }
  return { url, evalExpr, keepOpen };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const browserStatePath = CONFIG.browserStatePath;
  const storage = new EncryptedStorage(await resolveEncryptionKey(CONFIG));
  const decrypted = storage.readFile(browserStatePath);

  const tempDir = mkdtempSync(join(tmpdir(), 'latchkey-inspect-'));
  let storageStatePath: string | undefined;
  if (decrypted !== null) {
    storageStatePath = join(tempDir, 'storage.json');
    writeFileSync(storageStatePath, decrypted, { encoding: 'utf-8', mode: 0o600 });
    console.error(`[inspect] using existing browser state from ${browserStatePath}`);
  } else {
    console.error(`[inspect] no existing browser state; you may need to sign in`);
  }

  const { chromium } = await loadPlaywright();
  const launchOptions: LaunchOptions = {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(
    storageStatePath ? { storageState: storageStatePath } : {}
  );
  const page = await context.newPage();

  console.error(`[inspect] navigating to ${args.url}`);
  await page.goto(args.url, { timeout: 60000, waitUntil: 'domcontentloaded' });
  // Let Angular hydrate.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
    console.error('[inspect] networkidle timeout — continuing anyway');
  });

  const outDir = mkdtempSync(join(tmpdir(), 'latchkey-inspect-out-'));
  const html = await page.content();
  writeFileSync(join(outDir, 'page.html'), html, { encoding: 'utf-8' });
  await page.screenshot({ path: join(outDir, 'page.png'), fullPage: true });
  writeFileSync(join(outDir, 'url.txt'), page.url(), { encoding: 'utf-8' });
  console.error(`[inspect] dumped HTML/screenshot to ${outDir}`);
  console.error(`[inspect] final URL: ${page.url()}`);

  if (args.evalExpr) {
    try {
      // Cast to allow dynamic evaluation; the script runs in Node, the function in browser.
      const result = await page.evaluate(args.evalExpr as unknown as () => unknown);
      const out = JSON.stringify(result, null, 2);
      writeFileSync(join(outDir, 'eval.json'), out, { encoding: 'utf-8' });
      console.error(`[inspect] eval result written to ${outDir}/eval.json`);
      console.log(out);
    } catch (error) {
      console.error(`[inspect] eval error: ${(error as Error).message}`);
    }
  }

  if (args.keepOpen) {
    console.error('[inspect] keeping browser open. press Ctrl+C to exit.');
    await new Promise(() => {
      /* hang */
    });
  }

  await browser.close();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
