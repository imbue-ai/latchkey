#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const vitest = spawn(
  'npx',
  [
    'vitest',
    '--watch',
    '--exclude',
    'tests/lint.test.ts',
    '--exclude',
    'tests/typecheck.test.ts',
  ],
  { stdio: 'inherit' }
);

const watchedDirs = ['src', 'tests'];
const debounceMs = 150;
const pending = new Map();
const watchers = [];

for (const dir of watchedDirs) {
  watchers.push(
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !/\.tsx?$/.test(filename)) return;
      const fullPath = join(dir, filename);
      const existing = pending.get(fullPath);
      if (existing !== undefined) clearTimeout(existing);
      pending.set(
        fullPath,
        setTimeout(() => {
          pending.delete(fullPath);
          console.log(`\n[lint] ${fullPath}`);
          spawn('npx', ['eslint', fullPath], { stdio: 'inherit' });
        }, debounceMs)
      );
    })
  );
}

const shutdown = () => {
  for (const w of watchers) w.close();
  if (!vitest.killed) vitest.kill('SIGINT');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
vitest.on('exit', (code) => process.exit(code ?? 0));
