import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface AgentSkillConfig {
  /** Display name of the coding agent */
  name: string;
  /** Path relative to the user's home directory */
  globalDir: string;
  /** Path relative to the git repository root */
  projectDir: string;
}

export const AGENTS: readonly AgentSkillConfig[] = [
  {
    name: 'Claude',
    globalDir: '.claude/skills/latchkey',
    projectDir: '.claude/skills/latchkey',
  },
  {
    name: 'OpenCode',
    globalDir: '.config/opencode/skills/latchkey',
    projectDir: '.opencode/skills/latchkey',
  },
  {
    name: 'Codex',
    globalDir: '.agents/skills/latchkey',
    projectDir: '.agents/skills/latchkey',
  },
  {
    name: 'Gemini',
    globalDir: '.gemini/skills/latchkey',
    projectDir: '.gemini/skills/latchkey',
  },
];

export const SKILL_FILENAME = 'SKILL.md';

export type SkillScope = 'global' | 'project';

export interface InstallResult {
  agent: string;
  path: string;
  alreadyUpToDate: boolean;
}

export type SkillInstallStatus = 'up-to-date' | 'outdated' | 'missing' | 'unavailable';

export interface StatusResult {
  agent: string;
  scope: SkillScope;
  path: string;
  status: SkillInstallStatus;
}

/**
 * Finds the root of the git repository containing the current working directory.
 * Returns null if cwd is not inside a git repository.
 */
export function findGitRoot(): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Resolves the SKILL.md path for a given agent and scope.
 */
export function resolveSkillPath(
  agent: AgentSkillConfig,
  scope: SkillScope,
  home: string,
  gitRoot: string | null
): string | null {
  if (scope === 'global') {
    return join(home, agent.globalDir, SKILL_FILENAME);
  }
  if (gitRoot === null) {
    return null;
  }
  return join(gitRoot, agent.projectDir, SKILL_FILENAME);
}

/**
 * Installs the skill content to all agents for the given scope.
 * Returns install results for each agent.
 */
export function installSkill(
  scope: SkillScope,
  content: string,
  home: string = homedir(),
  gitRoot: string | null = findGitRoot()
): InstallResult[] {
  return AGENTS.map((agent) => {
    const skillPath = resolveSkillPath(agent, scope, home, gitRoot)!;
    const existingContent = existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : null;

    if (existingContent === content) {
      return { agent: agent.name, path: skillPath, alreadyUpToDate: true };
    }

    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, content, 'utf-8');
    return { agent: agent.name, path: skillPath, alreadyUpToDate: false };
  });
}

/**
 * Checks the installation status of the skill for all agents.
 * If scopeFilter is provided, only checks that scope; otherwise checks both.
 */
export function getSkillStatus(
  content: string,
  home: string = homedir(),
  gitRoot: string | null = findGitRoot(),
  scopeFilter?: SkillScope
): StatusResult[] {
  const results: StatusResult[] = [];
  const scopes: SkillScope[] = scopeFilter ? [scopeFilter] : ['global', 'project'];

  for (const scope of scopes) {
    for (const agent of AGENTS) {
      const skillPath = resolveSkillPath(agent, scope, home, gitRoot);

      if (skillPath === null) {
        results.push({ agent: agent.name, scope, path: '', status: 'unavailable' });
        continue;
      }

      if (!existsSync(skillPath)) {
        results.push({ agent: agent.name, scope, path: skillPath, status: 'missing' });
        continue;
      }

      const existingContent = readFileSync(skillPath, 'utf-8');
      const status = existingContent === content ? 'up-to-date' : 'outdated';
      results.push({ agent: agent.name, scope, path: skillPath, status });
    }
  }

  return results;
}
