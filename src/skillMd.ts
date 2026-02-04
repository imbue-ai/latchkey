import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function getSkillMdContent(): Promise<string> {
  return readFileSync(await getSkillMdPath(), 'utf-8');
}

async function getSkillMdPath(): Promise<string> {
  try {
    // @ts-expect-error - Bun-specific import attribute
    const mod = await import('../integrations/SKILL.md', { with: { type: 'text' } });
    return mod.default;
  } catch {
    return resolve(import.meta.dirname, '../integrations/SKILL.md');
  }
}