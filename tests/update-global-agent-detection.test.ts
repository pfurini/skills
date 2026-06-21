import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateGlobalSkills } from '../src/update.ts';
import { runAdd } from '../src/add.ts';
import { isSkillInstalled } from '../src/installer.ts';
import { readSkillLock } from '../src/skill-lock.ts';
import { fetchRepoTree, findSkillMdPaths, getSkillFolderHashFromTree } from '../src/blob.ts';

vi.mock('../src/add.ts', () => ({
  runAdd: vi.fn(),
}));

vi.mock('../src/skill-lock.ts', () => ({
  readSkillLock: vi.fn(),
  getGitHubToken: vi.fn(() => null),
}));

vi.mock('../src/blob.ts', () => ({
  fetchRepoTree: vi.fn(),
  findSkillMdPaths: vi.fn(),
  getSkillFolderHashFromTree: vi.fn(),
}));

vi.mock('../src/installer.ts', () => ({
  isSkillInstalled: vi.fn(),
}));

vi.mock('../src/agents.ts', () => ({
  agents: {
    'claude-code': { displayName: 'Claude Code', skillsDir: '.agents/skills' },
    cursor: { displayName: 'Cursor', skillsDir: '.cursor/skills' },
  },
  getUniversalAgents: vi.fn(() => ['claude-code']),
}));

describe('updateGlobalSkills agent detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only agents where the skill is currently installed', async () => {
    vi.mocked(readSkillLock).mockResolvedValue({
      version: 3,
      skills: {
        'gh-cli': {
          source: 'github/awesome-copilot',
          sourceType: 'github',
          sourceUrl: 'https://github.com/github/awesome-copilot',
          ref: 'main',
          skillPath: 'skills/gh-cli/SKILL.md',
          skillFolderHash: 'old-hash',
          installedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    });

    // The skill folder changed upstream (old-hash -> new-hash), and it is still
    // present in the repo tree (so it is not treated as a deletion).
    vi.mocked(fetchRepoTree).mockResolvedValue({ sha: 'tree-sha' } as never);
    vi.mocked(findSkillMdPaths).mockReturnValue(['skills/gh-cli/SKILL.md']);
    vi.mocked(getSkillFolderHashFromTree).mockReturnValue('new-hash');

    // The skill is only installed for claude-code, not cursor.
    vi.mocked(isSkillInstalled).mockImplementation(
      async (_skill, agent) => agent === 'claude-code'
    );

    const result = await updateGlobalSkills();

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(runAdd).toHaveBeenCalledTimes(1);
    expect(runAdd).toHaveBeenCalledWith(['github/awesome-copilot/skills/gh-cli#main'], {
      skill: ['gh-cli'],
      agent: ['claude-code'],
      global: true,
      yes: true,
    });
  });
});
