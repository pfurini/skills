import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { dirname, basename, join } from 'path';
import { getSkillLockPath, readSkillLock, addSkillToLock } from './skill-lock.ts';

// HOME is redirected to a throwaway dir by vitest.setup.ts, so these operate on
// an isolated global lock, never the developer's real ~/.agents/.skill-lock.json.

const lockPath = getSkillLockPath();
const lockDir = dirname(lockPath);

function siblingBackups(): string[] {
  if (!existsSync(lockDir)) return [];
  const base = basename(lockPath);
  return readdirSync(lockDir).filter((f) => f.startsWith(`${base}.`));
}

function entry(source: string) {
  return {
    source,
    sourceType: 'github',
    sourceUrl: `https://github.com/${source}`,
    skillFolderHash: 'hash',
  };
}

describe('skill-lock durability', () => {
  beforeEach(() => {
    // Start each test from a clean lock directory.
    if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
  });

  it('round-trips entries through an atomic write', async () => {
    await addSkillToLock('alpha', entry('o/alpha'));
    await addSkillToLock('beta', entry('o/beta'));

    const lock = await readSkillLock();
    expect(Object.keys(lock.skills).sort()).toEqual(['alpha', 'beta']);
  });

  it('keeps a .bak of the previous lock on overwrite', async () => {
    await addSkillToLock('alpha', entry('o/alpha'));
    await addSkillToLock('beta', entry('o/beta'));

    expect(existsSync(`${lockPath}.bak`)).toBe(true);
  });

  it('does NOT leave a temp file behind after writing', async () => {
    await addSkillToLock('alpha', entry('o/alpha'));
    const leftovers = siblingBackups().filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('backs up a corrupt lock instead of silently discarding it', async () => {
    // Simulate a truncated/interrupted write that left invalid JSON.
    writeFileSync(lockPath, '{ "version": 3, "skills": { "alpha":', 'utf-8');

    const lock = await readSkillLock();

    // Reading a corrupt lock yields an empty lock (so the CLI can proceed)...
    expect(lock.skills).toEqual({});
    // ...but the corrupt contents are preserved for recovery, never lost silently.
    const corruptBackups = siblingBackups().filter((f) => f.includes('.corrupt-'));
    expect(corruptBackups.length).toBeGreaterThan(0);
    expect(readFileSync(join(lockDir, corruptBackups[0]!), 'utf-8')).toContain('"alpha"');
  });

  it('REGRESSION: a write after a corrupt read cannot silently destroy tracking', async () => {
    // Reproduces the original data-loss bug: a corrupt on-disk lock, then an
    // add-style write. The added entry is written, but the previously-tracked
    // entries (now unrecoverable from the empty in-memory lock) must still be
    // retrievable from the corrupt backup left on disk.
    writeFileSync(
      lockPath,
      '{ "version": 3, "skills": { "keeper-1": {}, "keeper-2": {', // corrupt
      'utf-8'
    );

    await addSkillToLock('newly-added', entry('o/newly-added'));

    const corruptBackups = siblingBackups().filter((f) => f.includes('.corrupt-'));
    expect(corruptBackups.length).toBeGreaterThan(0);
    const recovered = readFileSync(join(lockDir, corruptBackups[0]!), 'utf-8');
    expect(recovered).toContain('keeper-1');
    expect(recovered).toContain('keeper-2');
  });

  it('rethrows non-ENOENT read errors instead of returning an empty lock', async () => {
    // A directory where the lock file is expected makes readFile fail with EISDIR
    // (not ENOENT). Returning an empty lock here would let the next write clobber
    // real data, so the error must surface.
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockPath, { recursive: true }); // lockPath is now a directory
    await expect(readSkillLock()).rejects.toThrow();
  });
});
