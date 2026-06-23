import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Redirect HOME to a throwaway directory for the duration of the test run.
//
// The CLI resolves the GLOBAL skill lock (`~/.agents/.skill-lock.json`) and the
// global skills dir (`~/.agents/skills`) from os.homedir(), which honours $HOME.
// Without this redirect, any test that exercises a `-g` / `--global` code path —
// or simply reads the lock — operates on the developer's REAL lock. Under
// vitest's default parallel file execution that is also a live corruption vector:
// concurrent non-atomic writes can truncate the real lock and wipe all tracking.
//
// setupFiles run once per test file (i.e. once per worker), so each file gets its
// own isolated HOME and parallel files never share a lock.
const isolatedHome = mkdtempSync(join(tmpdir(), 'skills-test-home-'));
process.env.HOME = isolatedHome;

// getSkillLockPath() prefers $XDG_STATE_HOME when set; clear any value inherited
// from the developer's environment so the lock always lands under the throwaway
// HOME (mirroring the production ~/.agents layout).
delete process.env.XDG_STATE_HOME;
