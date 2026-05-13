/**
 * DoorDash login debug harness.
 *
 * First run:  logs in via browser, saves full state to spike/doordash-state.json
 * Later runs: loads saved state, skips login, goes straight to cookie inspection
 *
 * Usage: npx tsx spike/doordash-debug-harness.ts [--fresh]
 *   --fresh  Force re-login even if saved state exists
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const STATE_PATH = resolve(import.meta.dirname, 'doordash-state.json');
const FRESH = process.argv.includes('--fresh');
const EXEC_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const hasState = !FRESH && existsSync(STATE_PATH);

const browser = await chromium.launch({
  headless: false,
  executablePath: EXEC_PATH,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

const context = await browser.newContext(
  hasState ? { storageState: STATE_PATH } : {}
);

// Track all Set-Cookie headers from doordash.com
const setCookieLog: { url: string; setCookie: string }[] = [];

context.on('response', async (response) => {
  const url = response.url();
  if (!/doordash\.com/.test(url)) return;

  try {
    const headersArray = await response.headersArray();
    for (const h of headersArray) {
      if (h.name.toLowerCase() === 'set-cookie') {
        setCookieLog.push({ url: url.slice(0, 120), setCookie: h.value });
        if (h.value.includes('ddweb_token') || h.value.includes('csrf_token')) {
          console.log(`\n*** SET-COOKIE HIT (headersArray): ${h.value.slice(0, 80)}...`);
          console.log(`    from: ${url.slice(0, 120)}`);
        }
      }
    }
    // Also test response.headers() which is what latchkey service uses
    const flatHeaders = response.headers();
    const flatSetCookie = flatHeaders['set-cookie'] ?? '';
    if (flatSetCookie.includes('ddweb_token')) {
      console.log(`\n*** FLAT headers()['set-cookie'] CONTAINS ddweb_token`);
      console.log(`    from: ${url.slice(0, 120)}`);
      console.log(`    value: ${flatSetCookie.slice(0, 200)}`);
    }
  } catch {
    // ignore
  }
});

const page = await context.newPage();

if (hasState) {
  console.log(`Loaded saved state from ${STATE_PATH}`);
  console.log('Navigating to doordash.com...');
  await page.goto('https://www.doordash.com/');
} else {
  console.log('No saved state. Opening login page — please log in manually.');
  await page.goto('https://www.doordash.com/consumer/login/');
}

// Poll for ddweb_token cookie (handles all async/redirect flows)
console.log('Waiting for ddweb_token cookie to appear (3 min timeout)...');
let found = false;
for (let i = 0; i < 90; i++) {
  const cookies = await context.cookies();
  if (cookies.some((c) => c.name === 'ddweb_token')) {
    found = true;
    console.log(`ddweb_token appeared after ~${String(i * 2)}s`);
    break;
  }
  await page.waitForTimeout(2000);
}
if (!found) {
  console.log('TIMEOUT: ddweb_token never appeared. Dumping state anyway...');
}

// Dump all cookies
const cookies = await context.cookies();
console.log(`\n=== ALL COOKIES (${String(cookies.length)}) ===`);
const ddCookies = cookies.filter((c) => c.domain.includes('doordash'));
console.log(`\nDoorDash cookies (${String(ddCookies.length)}):`);
for (const c of ddCookies) {
  const val = c.value.length > 30 ? c.value.slice(0, 30) + '...' : c.value;
  console.log(`  ${c.name} = ${val}  (domain: ${c.domain}, httpOnly: ${String(c.httpOnly)}, path: ${c.path})`);
}

// Check specifically for our targets
const ddweb = cookies.find((c) => c.name === 'ddweb_token');
const csrf = cookies.find((c) => c.name === 'csrf_token');
console.log(`\n=== TARGET COOKIES ===`);
console.log(`ddweb_token: ${ddweb ? `FOUND (domain: ${ddweb.domain}, val: ${ddweb.value.slice(0, 20)}...)` : 'MISSING'}`);
console.log(`csrf_token:  ${csrf ? `FOUND (domain: ${csrf.domain}, val: ${csrf.value.slice(0, 20)}...)` : 'MISSING'}`);

// Dump Set-Cookie log
if (setCookieLog.length > 0) {
  console.log(`\n=== SET-COOKIE LOG (${String(setCookieLog.length)} entries) ===`);
  const relevant = setCookieLog.filter(
    (e) => e.setCookie.includes('ddweb_token') || e.setCookie.includes('csrf_token')
  );
  if (relevant.length > 0) {
    console.log('Relevant entries:');
    for (const e of relevant) {
      console.log(`  ${e.url}`);
      console.log(`    ${e.setCookie.slice(0, 120)}`);
    }
  } else {
    console.log('No Set-Cookie entries contained ddweb_token or csrf_token.');
    console.log('First 10 entries:');
    for (const e of setCookieLog.slice(0, 10)) {
      console.log(`  ${e.url}`);
      console.log(`    ${e.setCookie.slice(0, 80)}`);
    }
  }
}

// Save state for next run
await context.storageState({ path: STATE_PATH });
console.log(`\nState saved to ${STATE_PATH}`);

await browser.close();
