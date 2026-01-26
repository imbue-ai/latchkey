import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

describe('Linter', () => {
  it('should pass linting', () => {
    expect(() => {
      execSync('npm run lint', {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
