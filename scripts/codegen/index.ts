/**
 * Codegen module that records browser actions and generates TypeScript code:
 * - Records user interactions (clicks, fills, navigations, etc.)
 * - Always generates TypeScript code
 * - Records all HTTP request metadata to a file
 * - Includes a custom toolbar with additional buttons
 *
 * The session has two phases:
 * - Pre-login: No recording, requests marked as pre-login
 * - Post-login: User interactions are recorded, requests marked as post-login
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import { chromium } from 'playwright';

import { CodeGenerator } from './codeGenerator.js';
import { createInjectedScript } from './injectedScript.js';
import { RequestMetadataCollector } from './requestMetadataCollector.js';
import type {
  CodegenOptions,
  CodegenResult,
  ElementInfo,
  RecordedAction,
  RecordingPhase,
} from './types.js';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Recordings directory relative to this module (scripts/recordings)
const RECORDINGS_DIRECTORY = resolve(__dirname, '..', 'recordings');

// Re-export types for external use
export type {
  CodegenOptions,
  CodegenResult,
  ElementInfo,
  RecordedAction,
  RecordingPhase,
  RequestMetadata,
} from './types.js';
export { CodegenError } from './types.js';

/**
 * Generate the prompt.txt content for creating a service definition.
 */
function generatePromptContent(name: string): string {
  return `Create a new service definition for ${name} with browser login support.

Typically, in a browser login session, the user will need to log in manually, and then the automation kicks in to generate an API key. The code needs to detect when the login stage has finished, and then use the Playwright API to perform automatic interactions, and finally retrieve the API key.

To help you derive this logic, I have recorded a sample user session:

The metadata of all requests during the session is recorded in scripts/recordings/${name}/requests.json. Each element contains a "phase" field that tells you whether this is before or after login.
Note that because the phase is derived from the user clicking a button that says "I'm logged in", some requests immediately after logging in may be marked incorrectly as pre-login. Examine the difference between these two sets of data and try to derive the simplest possible criteria. Some good candidates are:

- A request to the original URL with a difference in HTTP status code (the pre-login one will be a redirection, the post-login one will be 200). Note that the post-login request is likely to be marked incorrectly as pre-login because it's the very first request after login. Use the timestamp to figure out if that's the case.

- The presence of some kind of "auth" or "user" header in the request header.

The actions for generating an API key after the user has logged in is recorded in scripts/recordings/${name}/actions.js. For each element, think about how to derive a stable selector that doesn't depend on the user's language. Usually this means using readable IDs or CSS classes, which are unlikely to change. Some elements, such as submit buttons, may already be unique when matched by the type. If everything fails, fall back to using role + label.

Reference other service implementations to understand which patterns we use.
`;
}

/**
 * Run the codegen which opens a browser with recording enabled.
 * Injects a custom toolbar and records user actions and HTTP request metadata.
 *
 * Creates a scripts/recordings/$name/ directory with:
 * - actions.js: Recorded user actions
 * - requests.json: HTTP request metadata
 * - prompt.txt: Instructions for creating a service definition
 *
 * @returns Result containing the API key ancestry if selected by the user
 */
export async function runCodegen(options: CodegenOptions): Promise<CodegenResult> {
  const { name, url } = options;

  // Create recordings directory
  const recordingsDirectory = join(RECORDINGS_DIRECTORY, name);
  if (!existsSync(recordingsDirectory)) {
    mkdirSync(recordingsDirectory, { recursive: true });
  }

  const actionsFile = join(recordingsDirectory, 'actions.js');
  const requestsFile = join(recordingsDirectory, 'requests.json');
  const promptFile = join(recordingsDirectory, 'prompt.txt');

  // Write prompt.txt
  writeFileSync(promptFile, generatePromptContent(name), 'utf-8');

  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: false,
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  const browser = await chromium.launch(launchOptions);
  const context: BrowserContext = await browser.newContext();

  const requestCollector = new RequestMetadataCollector(requestsFile);
  const codeGenerator = new CodeGenerator(actionsFile);

  // Session state
  let currentPhase: RecordingPhase = 'pre-login';
  let apiKeyAncestry: ElementInfo[] | undefined;

  // Track HTTP requests and responses
  context.on('response', (response: Response) => {
    const request = response.request();
    requestCollector.addRequest(request, response);
  });

  context.on('requestfailed', (request: Request) => {
    requestCollector.addRequest(request, null);
  });

  // Inject our combined recorder and toolbar script into every page
  const injectedScript = createInjectedScript();

  await context.addInitScript(injectedScript);

  // Expose function to receive recorded actions from the page
  // Only records actions during post-login phase
  await context.exposeFunction(
    '__latchkeyRecordAction',
    (action: {
      type: string;
      ancestry?: ElementInfo[];
      value?: string;
      key?: string;
      url?: string;
    }) => {
      // Only record actions during post-login phase
      if (currentPhase !== 'post-login') {
        return;
      }

      codeGenerator.addAction({
        type: action.type as RecordedAction['type'],
        ancestry: action.ancestry,
        value: action.value,
        key: action.key,
        url: action.url,
        timestamp: Date.now(),
      });
    }
  );

  // Expose function to get current phase (called by toolbar)
  await context.exposeFunction('__latchkeyGetPhase', () => {
    return currentPhase;
  });

  // Expose function called when "I've logged in" button is clicked
  await context.exposeFunction('__latchkeyTransitionToPostLogin', () => {
    console.log('[Latchkey] Transitioning to post-login phase');
    currentPhase = 'post-login';
    requestCollector.setPhase('post-login');
  });

  // Expose function called when API key element is selected
  await context.exposeFunction('__latchkeyApiKeyElementSelected', (ancestry: ElementInfo[]) => {
    console.log(`[Latchkey] API key element selected with ${String(ancestry.length)} ancestors`);
    apiKeyAncestry = ancestry;
    codeGenerator.setApiKeyAncestry(ancestry);
  });

  const page: Page = await context.newPage();

  // Helper function to inject script after page load (needed because addInitScript
  // runs before DOM exists, so toolbar won't appear without this)
  async function injectScriptIfNeeded(targetPage: Page): Promise<void> {
    try {
      await targetPage.evaluate(injectedScript);
    } catch {
      // Ignore errors (e.g., if page is closed or navigating)
    }
  }

  // Navigate to initial URL
  codeGenerator.setInitialUrl(url);
  await page.goto(url);
  // Inject script after page loads
  await injectScriptIfNeeded(page);

  // Re-inject script after navigations
  page.on('load', () => {
    void injectScriptIfNeeded(page);
  });

  // Track navigations (only during post-login phase)
  page.on('framenavigated', (frame) => {
    // Only track main frame navigations during post-login
    if (frame === page.mainFrame() && currentPhase === 'post-login') {
      const url = frame.url();
      // Don't record about:blank
      if (url && url !== 'about:blank') {
        codeGenerator.addAction({
          type: 'navigate',
          url: url,
          timestamp: Date.now(),
        });
      }
    }
  });

  // Wait for browser to close
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      resolve();
    };

    browser.on('disconnected', cleanup);
    context.on('close', cleanup);
    page.on('close', cleanup);
  });

  // Ensure browser is fully closed
  try {
    await browser.close();
  } catch {
    // Browser may already be closed, ignore
  }

  // Final flush of collected data
  requestCollector.flush();
  codeGenerator.flush();

  console.log(`\nRecording saved to ${recordingsDirectory}/`);
  console.log(`  - actions.js: Recorded user actions`);
  console.log(`  - requests.json: HTTP request metadata`);
  console.log(`  - prompt.txt: Instructions for creating a service definition`);
  if (apiKeyAncestry) {
    console.log(
      `\nAPI key element ancestry captured with ${String(apiKeyAncestry.length)} elements`
    );
  }

  return { apiKeyAncestry };
}
