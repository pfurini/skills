import { readFile, writeFile, mkdir, rename, copyFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import pc from 'picocolors';

const AGENTS_DIR = '.agents';
const LOCK_FILE = '.skill-lock.json';
const CURRENT_VERSION = 3; // Bumped from 2 to 3 for folder hash support (GitHub tree SHA)

/**
 * Represents a single installed skill entry in the lock file.
 */
export interface SkillLockEntry {
  /** Normalized source identifier (e.g., "owner/repo", "mintlify/bun.com") */
  source: string;
  /** The provider/source type (e.g., "github", "mintlify", "huggingface", "local") */
  sourceType: string;
  /** The original URL used to install the skill (for re-fetching updates) */
  sourceUrl: string;
  /** Branch or tag ref used for installation (for ref-aware updates) */
  ref?: string;
  /** Subpath within the source repo, if applicable */
  skillPath?: string;
  /**
   * GitHub tree SHA for the entire skill folder.
   * This hash changes when ANY file in the skill folder changes.
   * Fetched via GitHub Trees API by the telemetry server.
   */
  skillFolderHash: string;
  /** ISO timestamp when the skill was first installed */
  installedAt: string;
  /** ISO timestamp when the skill was last updated */
  updatedAt: string;
  /** Name of the plugin this skill belongs to (if any) */
  pluginName?: string;
}

/**
 * Tracks dismissed prompts so they're not shown again.
 */
export interface DismissedPrompts {
  /** Dismissed the find-skills skill installation prompt */
  findSkillsPrompt?: boolean;
}

/**
 * The structure of the skill lock file.
 */
export interface SkillLockFile {
  /** Schema version for future migrations */
  version: number;
  /** Map of skill name to its lock entry */
  skills: Record<string, SkillLockEntry>;
  /** Tracks dismissed prompts */
  dismissed?: DismissedPrompts;
  /** Last selected agents for installation */
  lastSelectedAgents?: string[];
}

/**
 * Get the path to the global skill lock file.
 * Use $XDG_STATE_HOME/skills/.skill-lock.json if set.
 * otherwise fall back to ~/.agents/.skill-lock.json
 */
export function getSkillLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'skills', LOCK_FILE);
  }
  return join(homedir(), AGENTS_DIR, LOCK_FILE);
}

/**
 * Copy the lock file to a sibling backup path (best-effort).
 * Used before any operation that would otherwise discard existing entries,
 * so a corrupt or migrated lock is never silently lost.
 *
 * @returns The backup path if a copy was made, otherwise null.
 */
async function backupLockFile(lockPath: string, suffix: string): Promise<string | null> {
  const backupPath = `${lockPath}.${suffix}`;
  try {
    await copyFile(lockPath, backupPath);
    return backupPath;
  } catch {
    // Nothing to back up (file missing) or copy failed — not fatal.
    return null;
  }
}

/**
 * Read the skill lock file.
 *
 * Returns an empty lock file structure if the file genuinely doesn't exist.
 * On a corrupt or outdated lock the previous contents are ALWAYS backed up to a
 * sibling file before an empty lock is returned, so a transient read failure can
 * never silently cascade into a destructive write that wipes all tracking.
 *
 * Read errors other than "file not found" are rethrown rather than swallowed:
 * proceeding with an empty lock (and overwriting on the next write) would
 * destroy data we simply failed to read.
 */
export async function readSkillLock(): Promise<SkillLockFile> {
  const lockPath = getSkillLockPath();

  let content: string;
  try {
    content = await readFile(lockPath, 'utf-8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      // Genuinely absent — a fresh empty lock is correct.
      return createEmptyLockFile();
    }
    // EACCES/EIO/etc. — do NOT pretend the lock is empty; that would let the
    // next write clobber real entries. Surface the error instead.
    throw error;
  }

  let parsed: SkillLockFile;
  try {
    parsed = JSON.parse(content) as SkillLockFile;
  } catch {
    // Corrupt JSON (e.g. a truncated/interrupted write). Preserve it before any
    // caller overwrites the file, and tell the user where it went.
    const backup = await backupLockFile(lockPath, `corrupt-${process.pid}`);
    process.stderr.write(
      `${pc.yellow('│')}  ${pc.yellow('skills: skill lock file was corrupt and has been reset')}\n` +
        (backup ? `${pc.yellow('│')}  ${pc.dim(`Previous contents saved to ${backup}`)}\n` : '')
    );
    return createEmptyLockFile();
  }

  // Validate shape - back up before discarding so nothing is lost silently.
  if (typeof parsed.version !== 'number' || !parsed.skills) {
    await backupLockFile(lockPath, `invalid-${process.pid}`);
    return createEmptyLockFile();
  }

  // Old version: migration is backwards-incompatible (v3 adds skillFolderHash),
  // so we start fresh - but keep the old lock so entries can be recovered.
  if (parsed.version < CURRENT_VERSION) {
    await backupLockFile(lockPath, `v${parsed.version}`);
    return createEmptyLockFile();
  }

  return parsed;
}

/**
 * Write the skill lock file atomically.
 *
 * Writes to a temp file in the same directory and renames it over the target,
 * so a crash or concurrent invocation can never leave a half-written (corrupt)
 * lock on disk. The previous good lock is kept as a `.bak` sibling.
 */
export async function writeSkillLock(lock: SkillLockFile): Promise<void> {
  const lockPath = getSkillLockPath();

  // Ensure directory exists
  await mkdir(dirname(lockPath), { recursive: true });

  // Keep the previous lock as a backup before overwriting it.
  await backupLockFile(lockPath, 'bak');

  // Write with pretty formatting for human readability
  const content = JSON.stringify(lock, null, 2);

  // Atomic replace: write to a temp file, then rename over the target. rename(2)
  // is atomic within the same filesystem, so readers never see a partial file.
  const tmpPath = `${lockPath}.tmp-${process.pid}`;
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, lockPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Compute SHA-256 hash of content.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

let _ghWarningShown = false;

/** For tests only. Resets the one-shot warning flag. */
export function resetGhAuthWarning(): void {
  _ghWarningShown = false;
}

/**
 * Get GitHub token from user's environment.
 * Tries in order:
 * 1. GITHUB_TOKEN environment variable (silent)
 * 2. GH_TOKEN environment variable (silent)
 * 3. gh CLI auth token, if gh is installed. Prints a one-time warning to
 *    stderr before invoking `gh auth token`, because that subprocess call
 *    is flagged by some corporate endpoint security tooling (Defender, etc.)
 *    as credential extraction. Callers should invoke this function lazily
 *    (e.g. only after an unauthenticated request hits a rate limit) so the
 *    fallback rarely runs in practice.
 *
 * @returns The token string or null if not available
 */
export function getGitHubToken(): string | null {
  // Check environment variables first (silent: user has explicitly opted in)
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  // Last resort: spawn gh CLI. Warn the user once per process before doing so.
  if (!_ghWarningShown) {
    process.stderr.write(
      `${pc.yellow('│')}  ${pc.yellow('GitHub rate limit reached')} — using your ${pc.cyan('gh')} login to continue.\n` +
        `${pc.yellow('│')}  ${pc.dim(`Tip: set ${pc.cyan('GITHUB_TOKEN')} to avoid this prompt, or use ${pc.cyan('--full-depth')} to clone instead.\n`)}`
    );
    _ghWarningShown = true;
  }
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      return token;
    }
  } catch {
    // gh not installed or not authenticated
  }

  return null;
}

/**
 * Fetch the tree SHA (folder hash) for a skill folder using GitHub's Trees API.
 * This makes ONE API call to get the entire repo tree, then extracts the SHA
 * for the specific skill folder.
 *
 * @param ownerRepo - GitHub owner/repo (e.g., "vercel-labs/agent-skills")
 * @param skillPath - Path to skill folder or SKILL.md (e.g., "skills/react-best-practices/SKILL.md")
 * @param getToken - Optional lazy token resolver. Invoked only if the
 *                   unauthenticated request hits a rate limit.
 * @param ref - Optional branch/tag ref. Defaults to trying main then master.
 * @returns The tree SHA for the skill folder, or null if not found
 */
export async function fetchSkillFolderHash(
  ownerRepo: string,
  skillPath: string,
  getToken?: (() => string | null) | null,
  ref?: string
): Promise<string | null> {
  const { fetchRepoTree, getSkillFolderHashFromTree } = await import('./blob.ts');
  const tree = await fetchRepoTree(ownerRepo, ref, getToken ?? undefined);
  if (!tree) return null;
  return getSkillFolderHashFromTree(tree, skillPath);
}

/**
 * Add or update a skill entry in the lock file.
 */
export async function addSkillToLock(
  skillName: string,
  entry: Omit<SkillLockEntry, 'installedAt' | 'updatedAt'>
): Promise<void> {
  const lock = await readSkillLock();
  const now = new Date().toISOString();

  const existingEntry = lock.skills[skillName];

  lock.skills[skillName] = {
    ...entry,
    installedAt: existingEntry?.installedAt ?? now,
    updatedAt: now,
  };

  await writeSkillLock(lock);
}

/**
 * Remove a skill from the lock file.
 */
export async function removeSkillFromLock(skillName: string): Promise<boolean> {
  const lock = await readSkillLock();

  if (!(skillName in lock.skills)) {
    return false;
  }

  delete lock.skills[skillName];
  await writeSkillLock(lock);
  return true;
}

/**
 * Get a skill entry from the lock file.
 */
export async function getSkillFromLock(skillName: string): Promise<SkillLockEntry | null> {
  const lock = await readSkillLock();
  return lock.skills[skillName] ?? null;
}

/**
 * Get all skills from the lock file.
 */
export async function getAllLockedSkills(): Promise<Record<string, SkillLockEntry>> {
  const lock = await readSkillLock();
  return lock.skills;
}

/**
 * Get skills grouped by source for batch update operations.
 */
export async function getSkillsBySource(): Promise<
  Map<string, { skills: string[]; entry: SkillLockEntry }>
> {
  const lock = await readSkillLock();
  const bySource = new Map<string, { skills: string[]; entry: SkillLockEntry }>();

  for (const [skillName, entry] of Object.entries(lock.skills)) {
    const existing = bySource.get(entry.source);
    if (existing) {
      existing.skills.push(skillName);
    } else {
      bySource.set(entry.source, { skills: [skillName], entry });
    }
  }

  return bySource;
}

/**
 * Create an empty lock file structure.
 */
function createEmptyLockFile(): SkillLockFile {
  return {
    version: CURRENT_VERSION,
    skills: {},
    dismissed: {},
  };
}

/**
 * Check if a prompt has been dismissed.
 */
export async function isPromptDismissed(promptKey: keyof DismissedPrompts): Promise<boolean> {
  const lock = await readSkillLock();
  return lock.dismissed?.[promptKey] === true;
}

/**
 * Mark a prompt as dismissed.
 */
export async function dismissPrompt(promptKey: keyof DismissedPrompts): Promise<void> {
  const lock = await readSkillLock();
  if (!lock.dismissed) {
    lock.dismissed = {};
  }
  lock.dismissed[promptKey] = true;
  await writeSkillLock(lock);
}

/**
 * Get the last selected agents.
 */
export async function getLastSelectedAgents(): Promise<string[] | undefined> {
  const lock = await readSkillLock();
  return lock.lastSelectedAgents;
}

/**
 * Save the selected agents to the lock file.
 */
export async function saveSelectedAgents(agents: string[]): Promise<void> {
  const lock = await readSkillLock();
  lock.lastSelectedAgents = agents;
  await writeSkillLock(lock);
}
