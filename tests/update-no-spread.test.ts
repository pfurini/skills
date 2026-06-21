import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateProjectSkills } from '../src/update.ts';
import { runAdd } from '../src/add.ts';
import { readLocalLock } from '../src/local-lock.ts';

vi.mock('../src/add.ts', () => ({
  runAdd: vi.fn(),
}));

vi.mock('../src/local-lock.ts', () => ({
  readLocalLock: vi.fn(),
}));

vi.mock('../src/agents.ts', () => ({
  agents: {
    universal: { displayName: 'Universal', skillsDir: '.agents/skills' },
    'claude-code': { displayName: 'Claude Code', skillsDir: '.claude/skills' },
    cursor: { displayName: 'Cursor', skillsDir: '.cursor/skills' },
  },
  getUniversalAgents: vi.fn(() => ['universal']),
}));

// The deletion-check clones the source repo; keep it hermetic (no network/fs).
vi.mock('../src/git.ts', () => ({
  cloneRepo: vi.fn(async () => '/tmp/skills-update-clone'),
  cleanupTempDir: vi.fn(async () => {}),
}));

vi.mock('../src/skills.ts', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('updateProjectSkills no spread to agent-specific folders', () => {
  let tempDir: string;
  let oldCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    oldCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'skills-update-no-spread-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not create .claude, .cursor, or root skills folder during project update', async () => {
    vi.mocked(readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'my-skill': {
          source: 'vercel-labs/skills',
          sourceType: 'github',
          ref: 'main',
          computedHash: 'a'.repeat(64),
        },
      },
    });

    vi.mocked(runAdd).mockImplementation(async (_source, options) => {
      const skillNames = options?.skill ?? [];
      const agents = options?.agent ?? [];
      for (const skillName of skillNames) {
        for (const agent of agents) {
          if (agent === 'universal') {
            mkdirSync(join(tempDir, '.agents', 'skills', skillName), { recursive: true });
          }
          if (agent === 'claude-code') {
            mkdirSync(join(tempDir, '.claude', 'skills', skillName), { recursive: true });
          }
          if (agent === 'cursor') {
            mkdirSync(join(tempDir, '.cursor', 'skills', skillName), { recursive: true });
          }
        }
      }
    });

    await updateProjectSkills();

    expect(existsSync(join(tempDir, '.agents', 'skills', 'my-skill'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude'))).toBe(false);
    expect(existsSync(join(tempDir, '.cursor'))).toBe(false);
    expect(existsSync(join(tempDir, 'skills'))).toBe(false);
  });
});
