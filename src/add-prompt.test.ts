import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promptForAgents, selectAgentsInteractive } from './add.js';
import * as skillLock from './skill-lock.js';
import * as searchMultiselectModule from './prompts/search-multiselect.js';

// Mock dependencies
vi.mock('./skill-lock.js');
vi.mock('./prompts/search-multiselect.js');
vi.mock('./telemetry.js', () => ({
  setVersion: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../package.json', () => ({
  default: { version: '1.0.0' },
}));

describe('promptForAgents', () => {
  // Cast to any to avoid AgentType validation in tests
  const choices: any[] = [
    { value: 'opencode', label: 'OpenCode' },
    { value: 'cursor', label: 'Cursor' },
    { value: 'claude-code', label: 'Claude Code' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use default agents (claude-code, opencode, codex) when no history exists', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(undefined);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['opencode']);

    await promptForAgents('Select agents', choices);

    // Should default to claude-code, opencode, codex (filtered by available choices)
    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['claude-code', 'opencode'],
      })
    );
  });

  it('should use last selected agents when history exists', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['cursor']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['cursor']);

    await promptForAgents('Select agents', choices);

    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['cursor'],
      })
    );
  });

  it('should filter out invalid agents from history', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['cursor', 'invalid-agent']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['cursor']);

    await promptForAgents('Select agents', choices);

    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['cursor'],
      })
    );
  });

  it('should use default agents if all history agents are invalid', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['invalid-agent']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['opencode']);

    await promptForAgents('Select agents', choices);

    // When history is invalid, should fall back to defaults (claude-code, opencode, codex)
    // filtered by available choices
    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['claude-code', 'opencode'],
      })
    );
  });

  it('should save selected agents if not cancelled', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(undefined);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['opencode']);

    await promptForAgents('Select agents', choices);

    expect(skillLock.saveSelectedAgents).toHaveBeenCalledWith(['opencode']);
  });

  it('should not save agents if cancelled', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(undefined);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(
      searchMultiselectModule.cancelSymbol
    );

    await promptForAgents('Select agents', choices);

    expect(skillLock.saveSelectedAgents).not.toHaveBeenCalled();
  });
});

describe('selectAgentsInteractive', () => {
  // droid and augment are both non-universal agents; cursor is universal.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not pre-select a remembered agent that is not currently installed', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['droid', 'augment']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['augment']);

    // Only augment is detected on disk; droid (no .factory) must be dropped.
    await selectAgentsInteractive({ installedAgents: ['augment'] as any });

    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['augment'],
      })
    );
  });

  it('should pre-select remembered agents that are installed', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['droid', 'augment']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['droid', 'augment']);

    await selectAgentsInteractive({ installedAgents: ['droid', 'augment'] as any });

    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['droid', 'augment'],
      })
    );
  });

  it('should keep remembered agents when no installed list is provided', async () => {
    vi.mocked(skillLock.getLastSelectedAgents).mockResolvedValue(['droid']);
    vi.mocked(searchMultiselectModule.searchMultiselect).mockResolvedValue(['droid']);

    await selectAgentsInteractive({});

    expect(searchMultiselectModule.searchMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelected: ['droid'],
      })
    );
  });
});
