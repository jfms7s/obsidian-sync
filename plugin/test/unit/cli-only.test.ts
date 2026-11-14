// obsync-cli sync --only: the folder list, the marker file at the vault
// root, and the state that refuses a list it was not set up with.
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundFolder, VAULT_DIR_SETTING } from '../../cli/daemon';
import { CliError, EXIT_NEEDS_SETUP } from '../../cli/exit';
import { streamLogger } from '../../cli/log';
import { parseOnlyFolders, sameFolders, syncMarker } from '../../cli/only';
import { PersistentState } from '../../cli/state';
import { ONLY_MARKER_FILE } from '../../src/index';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'obsync-cli-only-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('--only', () => {
  it('parseOnlyFolders keeps plain folders, sorted and once each', () => {
    expect(parseOnlyFolders(['people/', 'mimir/', 'mimir/'])).toEqual(['mimir/', 'people/']);
    expect(parseOnlyFolders(['a/b/'])).toEqual(['a/b/']);
  });

  it('parseOnlyFolders refuses anything that is not a plain folder with a trailing slash', () => {
    for (const bad of [
      '', '/', 'mimir', '/mimir/', './mimir/', '../x/', 'a/../b/', 'a//b/', 'a/*/', 'a?/', '!a/', '[a]/', '#a/', ' mimir/',
      '.obsync-outside/', '.obsync-outside/a/', '.OBSYNC-Outside/', '.obsync-cli-only/', '.Obsync-Cli-Only/a/', 'secret:x/', 'SECRE~1/',
    ]) {
      expect(() => parseOnlyFolders(['fine/', bad]), bad).toThrow(CliError);
      // The list may be private: a refusal tells the folder by its position, never by name.
      const message = (() => {
        try {
          parseOnlyFolders(['fine/', bad]);
        } catch (err) {
          return (err as Error).message;
        }
        return '';
      })();
      expect(message, bad).toMatch(/^--only number 2: /);
      if (bad.length > 1) expect(message, bad).not.toContain(bad);
      expect(message, bad).not.toContain('fine');
    }
  });

  it('sameFolders compares two lists as sets', () => {
    expect(sameFolders(['mimir/', 'people/'], ['people/', 'mimir/'])).toBe(true);
    expect(sameFolders(['mimir/'], ['mimir/', 'people/'])).toBe(false);
    expect(sameFolders(['mimir/'], ['people/'])).toBe(false);
  });

  it('syncMarker writes one folder per line, mode 0644, and removes it without a list', async () => {
    await syncMarker(dir, ['mimir/', 'people/']);
    expect(await readFile(join(dir, ONLY_MARKER_FILE), 'utf8')).toBe('mimir/\npeople/\n');
    expect((await stat(join(dir, ONLY_MARKER_FILE))).mode & 0o777).toBe(0o644);
    await syncMarker(dir, null);
    await expect(stat(join(dir, ONLY_MARKER_FILE))).rejects.toThrow(/ENOENT/);
    expect(await readdir(dir)).toEqual([]); // no temp file left
    await syncMarker(dir, null); // nothing to remove
  });

  it('boundFolder refuses a first --only sync of a state that already holds files', async () => {
    const vaultDir = join(dir, 'vault');
    await mkdir(vaultDir);
    const ps = await PersistentState.open(join(dir, 'state'));
    try {
      // The binding was cleared (another vault chosen), but the state still knows a file.
      await ps.state.recordSynced({ fileId: 'aa', path: 'a.md', versionId: '01', deleted: false, contentHash: 'h', size: 1, localMtime: 5, hasBase: true, seq: 1 }, 'a');
      const err = await boundFolder({
        ps, vaultDir, once: true, init: true, only: ['mimir/'], trash: true, configDir: '.obsidian',
        log: streamLogger(() => undefined, false), stop: new Promise(() => undefined),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT_NEEDS_SETUP);
      expect(await ps.state.getSetting(VAULT_DIR_SETTING, null)).toBeNull(); // nothing was bound
      expect(await readdir(vaultDir)).toEqual([]);
    } finally {
      await ps.close();
    }
  });
});
