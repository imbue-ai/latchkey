/**
 * Diagnostic script: logs all Set-Cookie headers and cookies from doordash.com
 * during login to determine the right interception strategy.
 *
 * Usage: npx tsx spike/doordash-cookie-debug.ts
 */

import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

let ddwebFound = false;
let csrfFound = false;

context.on('response', async (response) => {
  const url = response.url();
  if (!/doordash\.com/.test(url)) return;

  const headers = response.headers();
  const setCookie = headers['set-cookie'] ?? '';

  if (setCookie.includes('ddweb_token') || setCookie.includes('csrf_token')) {
    console.log(`\n[SET-COOKIE] ${url}`);
    console.log(setCookie);
    if (setCookie.includes('ddweb_token')) ddwebFound = true;
    if (setCookie.includes('csrf_token')) csrfFound = true;
  }

  // Also check response headersArray for multi-value set-cookie
  try {
    const headersArray = await response.headersArray();
    for (const h of headersArray) {
      if (h.name.toLowerCase() === 'set-cookie') {
        if (h.value.includes('ddweb_token') || h.value.includes('csrf_token')) {
          console.log(`\n[SET-COOKIE-ARRAY] ${url}`);
          console.log(`  ${h.value}`);
        }
      }
    }
  } catch {
    // some responses may fail
  }
});

// Also check request cookies being sent
context.on('request', (request) => {
  const url = request.url();
  if (!/doordash\.com/.test(url)) return;

  const headers = request.headers();
  const cookie = headers['cookie'] ?? '';
  if (cookie.includes('ddweb_token')) {
    console.log(`\n[REQUEST-COOKIE] ${url}`);
    console.log(`  Has ddweb_token in request`);
  }
});

await page.goto('https://www.doordash.com/consumer/login/');
console.log('Log in manually in the browser. Watching for cookies...\n');

// Poll context cookies every 2 seconds
const interval = setInterval(async () => {
  const cookies = await context.cookies();
  const ddweb = cookies.find((c) => c.name === 'ddweb_token');
  const csrf = cookies.find((c) => c.name === 'csrf_token');
  if (ddweb || csrf) {
    console.log('\n[CONTEXT-COOKIES]');
    if (ddweb) console.log(`  ddweb_token = ${ddweb.value.slice(0, 30)}...`);
    if (csrf) console.log(`  csrf_token = ${csrf.value.slice(0, 30)}...`);
    if (ddweb && csrf) {
      console.log('\nBoth cookies found! Login detection would succeed here.');
      clearInterval(interval);
      setTimeout(async () => {
        await browser.close();
        process.exit(0);
      }, 2000);
    }
  }
}, 2000);

// Timeout after 3 minutes
setTimeout(async () => {
  console.log('\n[TIMEOUT] 3 minutes elapsed.');
  console.log(`ddweb_token in Set-Cookie: ${ddwebFound}`);
  console.log(`csrf_token in Set-Cookie: ${csrfFound}`);

  const cookies = await context.cookies();
  console.log('\nAll doordash cookies:');
  for (const c of cookies) {
    if (c.domain.includes('doordash')) {
      console.log(`  ${c.name} = ${c.value.slice(0, 20)}... (domain: ${c.domain})`);
    }
  }

  clearInterval(interval);
  await browser.close();
  process.exit(1);
}, 180_000);
