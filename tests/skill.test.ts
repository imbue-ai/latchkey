import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENTS,
  SKILL_FILENAME,
  getSkillStatus,
  installSkill,
  resolveSkillPath,
} from '../src/skill.js';

const SAMPLE_CONTENT = '# Latchkey Skill\n\nSample content for testing.';
const OUTDATED_CONTENT = '# Old content';

describe('resolveSkillPath', () => {
  it('returns global path under homedir for global scope', () => {
    const agent = AGENTS.find((a) => a.name === 'Claude')!;
    const path = resolveSkillPath(agent, 'global', '/home/user', '/repo');
    expect(path).toBe(`/home/user/${agent.globalDir}/${SKILL_FILENAME}`);
  });

  it('returns project path under gitRoot for project scope', () => {
    const agent = AGENTS.find((a) => a.name === 'Claude')!;
    const path = resolveSkillPath(agent, 'project', '/home/user', '/repo');
    expect(path).toBe(`/repo/${agent.projectDir}/${SKILL_FILENAME}`);
  });

  it('returns null for project scope when gitRoot is null', () => {
    const agent = AGENTS.find((a) => a.name === 'Claude')!;
    const path = resolveSkillPath(agent, 'project', '/home/user', null);
    expect(path).toBeNull();
  });

  it('resolves paths for all four agents', () => {
    const agentNames = AGENTS.map((a) => a.name);
    expect(agentNames).toContain('Claude');
    expect(agentNames).toContain('OpenCode');
    expect(agentNames).toContain('Codex');
    expect(agentNames).toContain('Gemini');
  });
});

describe('installSkill (global scope)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'latchkey-skill-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes SKILL.md for every agent', () => {
    const results = installSkill('global', SAMPLE_CONTENT, tmpHome, null);

    expect(results).toHaveLength(AGENTS.length);
    for (const result of results) {
      expect(result.alreadyUpToDate).toBe(false);
      const fileContent = readFileSync(result.path, 'utf-8');
      expect(fileContent).toBe(SAMPLE_CONTENT);
    }
  });

  it('creates intermediate directories', () => {
    installSkill('global', SAMPLE_CONTENT, tmpHome, null);

    for (const agent of AGENTS) {
      const skillPath = resolveSkillPath(agent, 'global', tmpHome, null)!;
      const fileContent = readFileSync(skillPath, 'utf-8');
      expect(fileContent).toBe(SAMPLE_CONTENT);
    }
  });

  it('reports alreadyUpToDate when content matches', () => {
    installSkill('global', SAMPLE_CONTENT, tmpHome, null);
    const results = installSkill('global', SAMPLE_CONTENT, tmpHome, null);

    for (const result of results) {
      expect(result.alreadyUpToDate).toBe(true);
    }
  });

  it('overwrites outdated content', () => {
    installSkill('global', OUTDATED_CONTENT, tmpHome, null);
    const results = installSkill('global', SAMPLE_CONTENT, tmpHome, null);

    for (const result of results) {
      expect(result.alreadyUpToDate).toBe(false);
      const fileContent = readFileSync(result.path, 'utf-8');
      expect(fileContent).toBe(SAMPLE_CONTENT);
    }
  });
});

describe('installSkill (project scope)', () => {
  let tmpHome: string;
  let tmpGitRoot: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'latchkey-skill-test-home-'));
    tmpGitRoot = mkdtempSync(join(tmpdir(), 'latchkey-skill-test-repo-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpGitRoot, { recursive: true, force: true });
  });

  it('writes SKILL.md under gitRoot for every agent', () => {
    const results = installSkill('project', SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    expect(results).toHaveLength(AGENTS.length);
    for (const result of results) {
      expect(result.path).toContain(tmpGitRoot);
      const fileContent = readFileSync(result.path, 'utf-8');
      expect(fileContent).toBe(SAMPLE_CONTENT);
    }
  });
});

describe('getSkillStatus', () => {
  let tmpHome: string;
  let tmpGitRoot: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'latchkey-skill-test-home-'));
    tmpGitRoot = mkdtempSync(join(tmpdir(), 'latchkey-skill-test-repo-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpGitRoot, { recursive: true, force: true });
  });

  it('reports missing for all agents when nothing is installed', () => {
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    for (const result of results) {
      expect(result.status).toBe('missing');
    }
  });

  it('reports up-to-date after install', () => {
    installSkill('global', SAMPLE_CONTENT, tmpHome, tmpGitRoot);
    installSkill('project', SAMPLE_CONTENT, tmpHome, tmpGitRoot);
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    for (const result of results) {
      expect(result.status).toBe('up-to-date');
    }
  });

  it('reports outdated when file content differs', () => {
    installSkill('global', OUTDATED_CONTENT, tmpHome, tmpGitRoot);
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    const globalResults = results.filter((r) => r.scope === 'global');
    for (const result of globalResults) {
      expect(result.status).toBe('outdated');
    }
  });

  it('reports unavailable for project scope when not in a git repo', () => {
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, null);

    const projectResults = results.filter((r) => r.scope === 'project');
    for (const result of projectResults) {
      expect(result.status).toBe('unavailable');
    }
  });

  it('returns results for all agents in both scopes', () => {
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    expect(results).toHaveLength(AGENTS.length * 2);
    const globalCount = results.filter((r) => r.scope === 'global').length;
    const projectCount = results.filter((r) => r.scope === 'project').length;
    expect(globalCount).toBe(AGENTS.length);
    expect(projectCount).toBe(AGENTS.length);
  });

  it('includes the file path in non-unavailable results', () => {
    installSkill('global', SAMPLE_CONTENT, tmpHome, null);
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot);

    const globalResults = results.filter((r) => r.scope === 'global');
    for (const result of globalResults) {
      expect(result.path).toContain(tmpHome);
      expect(result.path).toContain(SKILL_FILENAME);
    }
  });

  it('filters to global scope only when scopeFilter is global', () => {
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot, 'global');

    expect(results).toHaveLength(AGENTS.length);
    for (const result of results) {
      expect(result.scope).toBe('global');
    }
  });

  it('filters to project scope only when scopeFilter is project', () => {
    const results = getSkillStatus(SAMPLE_CONTENT, tmpHome, tmpGitRoot, 'project');

    expect(results).toHaveLength(AGENTS.length);
    for (const result of results) {
      expect(result.scope).toBe('project');
    }
  });
});
