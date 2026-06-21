import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    'claude-code': { displayName: 'Claude Code', skillsDir: '.agents/skills' },
    codex: { displayName: 'Codex', skillsDir: '.agents/skills' },
  },
  getUniversalAgents: vi.fn(() => ['claude-code', 'codex']),
}));

// The deletion-check clones the source repo; keep it hermetic (no network/fs).
vi.mock('../src/git.ts', () => ({
  cloneRepo: vi.fn(async () => '/tmp/skills-update-clone'),
  cleanupTempDir: vi.fn(async () => {}),
}));

vi.mock('../src/skills.ts', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('updateProjectSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only locked skill names and only universal agents', async () => {
    vi.mocked(readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-one': {
          source: 'vercel-labs/skills',
          ref: 'main',
          sourceType: 'github',
          computedHash: 'a'.repeat(64),
        },
        'skill-two': {
          source: 'vercel-labs/skills',
          ref: 'main',
          sourceType: 'github',
          computedHash: 'b'.repeat(64),
        },
        'sync-skill': {
          source: 'my-pkg',
          sourceType: 'node_modules',
          computedHash: 'c'.repeat(64),
        },
      },
    });

    const result = await updateProjectSkills();

    expect(result).toEqual({ successCount: 2, failCount: 0, foundCount: 2 });
    expect(runAdd).toHaveBeenCalledTimes(1);
    expect(runAdd).toHaveBeenCalledWith(['vercel-labs/skills#main'], {
      skill: ['skill-one', 'skill-two'],
      agent: ['claude-code', 'codex'],
      yes: true,
    });
  });
});
