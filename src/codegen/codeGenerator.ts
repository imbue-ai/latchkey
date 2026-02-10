/**
 * Generates TypeScript code from recorded actions.
 */

import { writeFileSync } from 'node:fs';
import type { RecordedAction } from './types.js';

export class CodeGenerator {
  private readonly actions: RecordedAction[] = [];
  private readonly outputPath: string;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  addAction(action: RecordedAction): void {
    this.actions.push(action);
    this.flush();
  }

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  private generateActionCode(action: RecordedAction): string {
    switch (action.type) {
      case 'navigate':
        return `  await page.goto('${this.escapeString(action.url ?? '')}');`;
      case 'click':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').click();`;
      case 'fill':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').fill('${this.escapeString(action.value ?? '')}');`;
      case 'press':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').press('${this.escapeString(action.key ?? '')}');`;
      case 'select':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').selectOption('${this.escapeString(action.value ?? '')}');`;
      case 'check':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').check();`;
      case 'uncheck':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').uncheck();`;
      default: {
        const unknownType: never = action.type;
        return `  // Unknown action: ${String(unknownType)}`;
      }
    }
  }

  generateCode(): string {
    const header = `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

`;

    const footer = `
  // ---------------------
  await context.close();
  await browser.close();
})();
`;

    const actionLines = this.actions.map((action) => this.generateActionCode(action));
    return header + actionLines.join('\n') + footer;
  }

  flush(): void {
    writeFileSync(this.outputPath, this.generateCode(), 'utf-8');
  }
}
