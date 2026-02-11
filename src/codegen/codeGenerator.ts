/**
 * Generates TypeScript code from recorded actions.
 * Uses page.getByRole where possible and outputs element ancestry for AI post-processing.
 */

import { writeFileSync } from 'node:fs';
import type { ElementInfo, RecordedAction } from './types.js';

export class CodeGenerator {
  private readonly actions: RecordedAction[] = [];
  private readonly outputPath: string;
  private actionCounter = 0;
  private apiKeyAncestry: ElementInfo[] | undefined;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  addAction(action: RecordedAction): void {
    this.actions.push(action);
    this.flush();
  }

  setApiKeyAncestry(ancestry: ElementInfo[]): void {
    this.apiKeyAncestry = ancestry;
    this.flush();
  }

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  private generateGetByRole(element: ElementInfo): string | null {
    if (!element.role) return null;

    const role = element.role;
    const name = element.accessibleName;

    if (name) {
      return `page.getByRole('${role}', { name: '${this.escapeString(name)}' })`;
    }
    return `page.getByRole('${role}')`;
  }

  private generateGetByPlaceholder(element: ElementInfo): string | null {
    if (!element.placeholder) return null;
    return `page.getByPlaceholder('${this.escapeString(element.placeholder)}')`;
  }

  private generateGetByLabel(element: ElementInfo): string | null {
    if (!element.accessibleName) return null;
    if (element.tag !== 'input' && element.tag !== 'textarea' && element.tag !== 'select') return null;
    return `page.getByLabel('${this.escapeString(element.accessibleName)}')`;
  }

  private generateLocator(target: ElementInfo): { locator: string; strategy: string } {
    // Try getByRole first (Playwright best practice)
    let locator = this.generateGetByRole(target);
    if (locator) {
      return { locator, strategy: 'getByRole' };
    }

    // Try getByPlaceholder
    locator = this.generateGetByPlaceholder(target);
    if (locator) {
      return { locator, strategy: 'getByPlaceholder' };
    }

    // Try getByLabel
    locator = this.generateGetByLabel(target);
    if (locator) {
      return { locator, strategy: 'getByLabel' };
    }

    // Fallback to locator with a simple selector
    if (target.id) {
      return { locator: `page.locator('#${target.id}')`, strategy: 'id' };
    }
    if (target.className) {
      const firstClass = target.className.split(/\s+/)[0] ?? '';
      return { locator: `page.locator('.${firstClass}')`, strategy: 'class' };
    }
    return { locator: `page.locator('${target.tag}')`, strategy: 'tag' };
  }

  private formatElementInfo(element: ElementInfo): string {
    const parts: string[] = [`tag: ${element.tag}`];

    if (element.id) {
      parts.push(`id: "${element.id}"`);
    }
    if (element.className) {
      parts.push(`class: "${element.className}"`);
    }
    if (element.name) {
      parts.push(`name: "${element.name}"`);
    }
    if (element.role) {
      parts.push(`role: ${element.role}`);
    }
    if (element.accessibleName) {
      parts.push(`accessibleName: "${this.escapeString(element.accessibleName)}"`);
    }
    if (element.inputType) {
      parts.push(`type: ${element.inputType}`);
    }
    if (element.placeholder) {
      parts.push(`placeholder: "${this.escapeString(element.placeholder)}"`);
    }

    return `{ ${parts.join(', ')} }`;
  }

  private formatAncestryComments(ancestry: readonly ElementInfo[]): string[] {
    const lines: string[] = [];
    lines.push(`  // Element ancestry (root -> target):`);

    // Output ancestry in reverse order (root first, target last)
    for (let i = ancestry.length - 1; i >= 0; i--) {
      const element = ancestry[i];
      if (element) {
        const depth = ancestry.length - 1 - i;
        const indent = '  '.repeat(depth);
        const marker = i === 0 ? ' [TARGET]' : '';
        lines.push(`  //   ${indent}${this.formatElementInfo(element)}${marker}`);
      }
    }

    return lines;
  }

  private generateActionCode(action: RecordedAction): string {
    // Navigation doesn't need ancestry
    if (action.type === 'navigate') {
      return `  await page.goto('${this.escapeString(action.url ?? '')}');`;
    }

    const ancestry = action.ancestry ?? [];
    const target = ancestry[0];
    if (!target) {
      return `  // Action ${action.type} with no element info`;
    }

    this.actionCounter++;
    const actionId = this.actionCounter;

    // Determine the action method
    let actionMethod: string;
    switch (action.type) {
      case 'click':
        actionMethod = '.click()';
        break;
      case 'fill':
        actionMethod = `.fill('${this.escapeString(action.value ?? '')}')`;
        break;
      case 'press':
        actionMethod = `.press('${this.escapeString(action.key ?? '')}')`;
        break;
      case 'select':
        actionMethod = `.selectOption('${this.escapeString(action.value ?? '')}')`;
        break;
      case 'check':
        actionMethod = '.check()';
        break;
      case 'uncheck':
        actionMethod = '.uncheck()';
        break;
      default: {
        const unknownType: never = action.type;
        return `  // Unknown action: ${String(unknownType)}`;
      }
    }

    const { locator: primaryLocator, strategy: locatorType } = this.generateLocator(target);

    // Build the output with ancestry information (root -> target order)
    const lines: string[] = [];
    lines.push(`  // ===== ACTION ${String(actionId)}: ${action.type} =====`);
    lines.push(...this.formatAncestryComments(ancestry));
    lines.push(`  // Locator strategy: ${locatorType}`);
    lines.push(`  await ${primaryLocator}${actionMethod};`);
    lines.push('');

    return lines.join('\n');
  }

  generateCode(): string {
    // Reset counter for consistent output
    this.actionCounter = 0;

    const header = `// Generated by Latchkey Codegen
// Each action includes element ancestry for AI post-processing to synthesize optimal selectors.
// The active locator uses page.getByRole where possible (Playwright best practice).

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

`;

    const footer = `  // ---------------------
  await context.close();
  await browser.close();
})();
`;

    const actionLines = this.actions.map((action) => this.generateActionCode(action));

    // Generate API key extraction code if ancestry was set
    let apiKeyCode = '';
    if (this.apiKeyAncestry && this.apiKeyAncestry.length > 0) {
      const ancestry = this.apiKeyAncestry;
      const target = ancestry[0];

      if (target) {
        const { locator: primaryLocator, strategy: locatorType } = this.generateLocator(target);

        // Build ancestry information
        const ancestryLines: string[] = [];
        ancestryLines.push(`  // ===== API KEY EXTRACTION =====`);
        ancestryLines.push(...this.formatAncestryComments(ancestry));
        ancestryLines.push(`  // Locator strategy: ${locatorType}`);
        ancestryLines.push(`  const apiKey = await ${primaryLocator}.textContent();`);
        ancestryLines.push(`  console.log('API Key:', apiKey);`);
        ancestryLines.push(`  // ===== END API KEY EXTRACTION =====`);
        ancestryLines.push('');

        apiKeyCode = '\n' + ancestryLines.join('\n') + '\n';
      }
    }

    return header + actionLines.join('\n') + apiKeyCode + footer;
  }

  flush(): void {
    writeFileSync(this.outputPath, this.generateCode(), 'utf-8');
  }
}
