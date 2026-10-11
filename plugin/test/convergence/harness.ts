// The convergence suite (spec §8): N simulated devices run the real engine
// against the real server, doing random operations from a seed, then must
// end with byte-identical vaults and no lost edit.
//
// "No edit lost" is checked with tokens. Every operation that writes
// content writes a fresh, unique token (a line in text files, a marker in
// binary files). A token may legitimately disappear only through an
// operation that removed it on a device that could see it: a delete of the
// file holding it, a line replacement, a binary overwrite, or a restore of
// an older version. Such tokens go into `removed`. At the end, every token
// ever written and not in `removed` must appear in some file of the final
// vault, possibly a conflict copy.
//
// The settled vaults must also match the server: every live head (its path
// and content hash, decrypted with a device's keys) is on every device with
// that content, and no device has a file the server does not hold live.
//
// Conflict copies are checked both ways. Every copy in the final vault must
// come from a conflict or collision event, and every copy an event reported
// (merge conflicts and collisions alike) must still be there unless the
// harness itself deleted or renamed that name after the copy appeared (the
// random operations pick any existing file, copies included). Copies are
// told apart by name and by the step they appeared at on some device: copy
// names can repeat once a copy is gone, and a file id would not help, since
// it is derived from the name (fileIdFor).
//
// Coverage. Every operation counts as run (ops) when it was not skipped, and
// as an effect (effects) only when it changed something: a lost commit
// response counts once a response was really lost, a sync once the cycle
// committed or applied something. convergence.test.ts fails a run in which
// some kind had far fewer effects than its usual rate.
//
// Fleets. A case-insensitive device cannot hold two names that differ only
// in case, so a case-sensitive device and a case-insensitive one would end
// with different vaults whenever such names exist. A seed therefore uses one
// of three fleets: `mixed` (the last device is case-insensitive; the paths
// never differ only in case), `sensitive` and `insensitive` (all devices
// alike; case-only renames and case variants of paths are in play).
//
// In a third of the seeds (spread over all three fleets) dev1 keeps
// whole-second mtimes, like a phone or a FAT card: an edit within the same
// second as another write keeps the file's size and mtime when its length
// does not change, so only the content tells it changed.
//
// Edits during a cycle. Most operations happen between cycles. The
// 'edit-mid-cycle' operation arms the device's adapter so that the engine's
// next read of a chosen file is followed at once by a user edit of that file
// (keeping its length half the time), and then runs a cycle: the engine
// carries on with what it read while the file has already changed under it.
// Tokens all have the same width within a seed, so replacing one keeps the
// file's length.
import type { ApiClient } from '../../src/api/client';
import { NetworkError } from '../../src/api/errors';
import { CHUNK_SIZE } from '../../src/api/limits';
import { decryptMeta } from '../../src/crypto/objects';
import type { VaultKeyring } from '../../src/crypto/vaultkeys';
import { fileHistory, listTrash, NotInTrashError, PathOccupiedError, restore, UnsyncedChangesError } from '../../src/services/history';
import { hashHex } from '../../src/sync/content';
import { equalBytes, toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { caseFold, CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { seededRandom } from '../../src/util/random';
import { makeClient, settle, type SimClient } from '../helpers/client';
import type { LostResponse } from '../helpers/net';
import type { User } from '../helpers/fixture';
import type { TestServer } from '../helpers/server';

export type Fleet = 'mixed' | 'sensitive' | 'insensitive';
export const FLEETS: readonly Fleet[] = ['mixed', 'sensitive', 'insensitive'];

/** The fleet a seed uses unless told otherwise, so every default run covers all three. */
export function fleetFor(seed: number): Fleet {
  return FLEETS[seed % FLEETS.length]!;
}

/** Whether dev1 keeps whole-second mtimes: a third of the seeds, in every fleet (seeds 3-5, 12-14, …). */
export function coarseMtimeFor(seed: number): boolean {
  return Math.floor(seed / FLEETS.length) % 3 === 1;
}

export interface SeedOptions {
  seed: number;
  clients?: number;
  steps?: number;
  fleet?: Fleet;
  /** Whether dev1 keeps whole-second mtimes; default coarseMtimeFor(seed). */
  coarseMtime?: boolean;
}

export interface SeedReport {
  seed: number;
  fleet: Fleet;
  /** Whether dev1 kept whole-second mtimes. */
  coarseMtime: boolean;
  files: number;
  conflictCopies: number;
  tokens: number;
  /** How often each kind of operation ran (skipped ones are not counted). */
  ops: Record<string, number>;
  /** How often each kind of operation changed something (see the header). */
  effects: Record<string, number>;
  log: string[];
}

// 'Notes' and 'Notes/Deep' are files whose names are also folders in other
// paths: devices that make one and the other meet in a file/folder collision.
// 'Scratch/' is what the ignore toggles ignore.
const TEXT_PATHS = ['a.md', 'b.md', 'c.md', 'Notes/d.md', 'Notes/e.md', 'Notes/Deep/f.md', 'g.txt', 'h.canvas', 'Notes', 'Notes/Deep', 'Scratch/s1.md', 'Scratch/s2.md'];
const BINARY_PATHS = ['img.png', 'Notes/doc.pdf'];
/** Two chunks long, so multi-chunk files are pushed, pulled and merged too (in 1 seed of 10, since it is big). */
const BIG_PATH = 'big.bin';

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

const flipCase = (ch: string) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());

/** The same name with the first letter of the file name in the other case ('a.md' ↔ 'A.md', 'Notes' ↔ 'notes'). */
export function caseVariant(path: string): string {
  const slash = path.lastIndexOf('/') + 1;
  return path.slice(0, slash) + flipCase(path.charAt(slash)) + path.slice(slash + 1);
}

/** The same path with the first letter of its top folder in the other case ('Notes/d.md' ↔ 'notes/d.md'); a path with no folder is returned unchanged. */
export function folderCaseVariant(path: string): string {
  return path.includes('/') ? flipCase(path.charAt(0)) + path.slice(1) : path;
}

/**
 * The fewest effects per 100 seeds each kind of operation must reach, about a
 * fifth of what it reaches on average (measured over seeds 1-1000 on
 * 2026-10-11 with the weights in OPS; re-measure when they change). A kind is only checked when
 * the run's share comes to 2 or more, so that the bound stays far below what
 * any run of that size reaches by chance (a run of 20 seeds checks the common
 * kinds, a release run of 1,000 all of them).
 */
export const MIN_EFFECTS_PER_100_SEEDS: Readonly<Record<string, number>> = {
  'backup': 11.1,
  'case-rename': 21.6,
  'crash-after-commit': 5.6,
  'create': 240.3,
  'delete': 58.3,
  'edit': 191.5,
  'edit-mid-cycle': 17.1,
  'history-restore': 0.9,
  'hot-backup': 12.5,
  'ignore': 23.0,
  'lose-commit': 26.6,
  'network': 85.3,
  'rename': 59.8,
  'restart': 35.4,
  'restore-backup': 4.8,
  'sync': 58.5,
  'trash-restore': 1.7,
};

/** The kinds of operation whose effects fell short of MIN_EFFECTS_PER_100_SEEDS in a run of `seeds` seeds, described. */
export function coverageShortfalls(effects: Record<string, number>, seeds: number): string[] {
  const out: string[] = [];
  for (const [kind, per100] of Object.entries(MIN_EFFECTS_PER_100_SEEDS)) {
    const need = Math.floor((per100 * seeds) / 100);
    const got = effects[kind] ?? 0;
    if (need >= 2 && got < need) out.push(`${kind}: ${got} effects in ${seeds} seeds, expected at least ${need}`);
  }
  return out;
}

const isBinary = (p: string) => /\.(png|pdf|bin)$/i.test(p);
const tokensIn = (data: Uint8Array) => latin1.decode(data).match(/<<s\d+\.c\d+\.t\d+>>/g) ?? [];

/** An error a history or trash restore is allowed to end with: the situation it guards against. */
const isExpectedRestoreError = (err: unknown) =>
  err instanceof UnsyncedChangesError || err instanceof PathOccupiedError || err instanceof NotInTrashError || err instanceof NetworkError;

/**
 * The result of a request the harness makes itself (listing history or the
 * trash), or null when the network failed, as the restore screens would show
 * an error. A pooled connection to a server that a backup or restore just
 * restarted can be reset.
 */
async function unlessNetworkFails<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof NetworkError) return null;
    throw err;
  }
}

/** Weights of the random operations; a roll picks the first one whose running total exceeds it. */
const OPS: ReadonlyArray<readonly [string, number]> = [
  ['create', 0.2], ['edit', 0.22], ['edit-mid-cycle', 0.04], ['rename', 0.07], ['case-rename', 0.04], ['delete', 0.07],
  ['network', 0.07], ['lose-commit', 0.03], ['crash-after-commit', 0.02], ['restart', 0.03],
  ['history-restore', 0.02], ['trash-restore', 0.02], ['ignore', 0.02], ['backup', 0.01], ['hot-backup', 0.01], ['restore-backup', 0.01],
  ['sync', 0.12],
];

export async function runSeed(srv: TestServer, o: SeedOptions): Promise<SeedReport> {
  const rnd = seededRandom(o.seed);
  const n = o.clients ?? 3;
  const steps = o.steps ?? 60;
  const fleet = o.fleet ?? fleetFor(o.seed);
  const coarse = o.coarseMtime ?? coarseMtimeFor(o.seed);
  const label = coarse ? `${fleet}, dev1 with whole-second mtimes` : fleet;
  const withBig = o.seed % 10 === 0;
  const caseOps = fleet !== 'mixed';
  const paths = [...TEXT_PATHS, ...BINARY_PATHS, ...(withBig ? [BIG_PATH] : [])];
  // Case variants of file names and of the top folder ('notes/d.md' next to 'Notes/e.md').
  const universe = caseOps ? [...new Set([...paths, ...paths.map(caseVariant), ...paths.map(folderCaseVariant)])] : paths;
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const user: User = { username: `conv${o.seed}x${Math.floor(rnd.float() * 1e9)}`, password: 'password123' };
  await srv.createUser(user.username, user.password);

  const clients: SimClient[] = [];
  // Clients are stopped and their state closed however the seed ends, so a
  // failing seed does not leave engines running into the next one.
  let ok = false;
  try {
    for (let i = 0; i < n; i++) {
      clients.push(await makeClient(srv, user, {
        name: `dev${i}`, vault: i === 0 ? 'create' : clients[0]!.vaultId,
        random: seededRandom(o.seed * 1000 + i + 1), clock,
        caseInsensitive: fleet === 'insensitive' || (fleet === 'mixed' && i === n - 1),
        coarseMtime: coarse && i === 1,
      }));
    }

    const log: string[] = [];
    const ops: Record<string, number> = {};
    const effects: Record<string, number> = {};
    /** Armed lost commit responses (lose-commit), counted as effects at the end once they fired. */
    const armedLosses: LostResponse[] = [];
    const written = new Set<string>();
    const removed = new Set<string>();
    let backup: string | null = null;
    let tokenN = 0;
    const token = (c: number) => {
      // Fixed width, so replacing one token with another keeps a file's length.
      const t = `<<s${o.seed}.c${c}.t${String(tokenN++).padStart(4, '0')}>>`;
      written.add(t);
      return t;
    };
    // Copies the harness itself renamed (a case-only rename of a copy): the copy keeps its name pattern but has no event under the new name.
    const renamedCopies = new Set<string>();
    // Every copy an event reported (conflict, or a collision notice naming it), with the step it was seen at.
    const copiesSeen: Array<{ path: string; device: string; step: number; kind: 'conflict' | 'collision' }> = [];
    const eventsRead = clients.map(() => 0);
    const collectCopies = (step: number) => {
      clients.forEach((c, i) => {
        for (const e of c.events.slice(eventsRead[i])) {
          if (e.type === 'conflict') copiesSeen.push({ path: e.conflictPath, device: c.name, step, kind: 'conflict' });
          else if (e.type === 'notice' && e.conflictPath !== undefined) copiesSeen.push({ path: e.conflictPath, device: c.name, step, kind: 'collision' });
        }
        eventsRead[i] = c.events.length;
      });
    };
    const foldName = (p: string) => (fleet === 'sensitive' ? p : caseFold(p));
    // The steps at which each copy name (folded) appeared on some device, having been on none: an
    // event can name a copy later than it appeared (a device that was offline reports it when it
    // meets it), so a removal counts from when the copy was there, not from when it was reported.
    const copyAppearances = new Map<string, number[]>();
    let copiesPresent = new Set<string>();
    const scanCopies = async (step: number) => {
      const now = new Set<string>();
      for (const c of clients) for (const p of await c.adapter.list()) if (CONFLICT_COPY_PATTERN.test(p)) now.add(foldName(p));
      for (const n of now) if (!copiesPresent.has(n)) copyAppearances.set(n, [...(copyAppearances.get(n) ?? []), step]);
      copiesPresent = now;
    };
    /** The step the copy reported at step `seen` appeared at: its last appearance up to then (or its first after, for an event ahead of the scan). */
    const appearedAt = (path: string, seen: number) => {
      const steps = copyAppearances.get(foldName(path)) ?? [seen];
      return steps.filter((x) => x <= seen).pop() ?? steps[0]!;
    };
    // Copy names the harness deleted or renamed away, with the step.
    const copyRemovals: Array<{ path: string; step: number }> = [];
    let currentStep = 0;
    const noteRemoval = (p: string) => {
      if (CONFLICT_COPY_PATTERN.test(p)) copyRemovals.push({ path: p, step: currentStep });
    };

    /** A new file can be created at p here: nothing there, no folder with files at p, no file where a folder must be. */
    const placeFree = async (c: SimClient, p: string): Promise<boolean> => {
      if ((await c.adapter.stat(p)) || (await c.adapter.hasFolder(p))) return false;
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) if (await c.adapter.stat(parts.slice(0, i).join('/'))) return false;
      return true;
    };
    const freeAmong = async (c: SimClient, candidates: readonly string[]) => {
      const out: string[] = [];
      for (const p of candidates) if (await placeFree(c, p)) out.push(p);
      return out;
    };
    const payload = (p: string, t: string): Uint8Array => {
      if (p.toLowerCase().endsWith(BIG_PATH)) {
        // The first chunk is the same in every version (so the server has it already) unless the
        // write also touches it; the token that tells versions apart is in the last chunk.
        const data = new Uint8Array(CHUNK_SIZE + 4096).fill(0x41);
        const tb = enc.encode(t);
        data.set(tb, data.length - tb.length - 8);
        if (rnd.float() < 0.4) data.set(tb, 16);
        return data;
      }
      return isBinary(p) ? new Uint8Array([...rnd.bytes(8), ...enc.encode(t), ...rnd.bytes(8)]) : enc.encode(`# ${p}\n${t}\n`);
    };
    const localFiles = async (c: SimClient) => (await c.adapter.list()).filter((p) => !p.startsWith('.'));
    /** Tokens that were in path (before) and are not any more: removed on purpose. */
    const noteRemovedTokens = async (c: SimClient, p: string, before: readonly string[]) => {
      const after = new Set(tokensIn((await c.adapter.read(p)) ?? new Uint8Array(0)));
      for (const t of before) if (!after.has(t)) removed.add(t);
    };
    /**
     * A user edit of p (whose content is old) on device ci: a binary file is
     * overwritten (same length: tokens have a fixed width); a text file gets a
     * token line inserted, or with replace one of its token lines replaced,
     * which keeps its length.
     */
    const userEdit = async (c: SimClient, ci: number, p: string, old: Uint8Array, replace: boolean): Promise<string> => {
      const t = token(ci);
      if (isBinary(p)) {
        for (const x of tokensIn(old)) removed.add(x);
        await c.adapter.write(p, payload(p, t));
        return `overwrite ${p} ${t}`;
      }
      const lines = new TextDecoder().decode(old).split('\n');
      const tokenLines = lines.map((l, i) => (/^<<s/.test(l) ? i : -1)).filter((i) => i >= 0);
      let what: string;
      if (replace && tokenLines.length > 0) {
        const i = rnd.pick(tokenLines);
        removed.add(lines[i]!);
        lines[i] = t;
        what = `replace-line ${p} ${t}`;
      } else {
        const at = rnd.int(lines.length);
        lines.splice(at, 0, t);
        what = `insert ${p}@${at} ${t}`;
      }
      await c.adapter.write(p, enc.encode(lines.join('\n')));
      return what;
    };

    for (let step = 0; step < steps; step++) {
      currentStep = step;
      clock.advance(rnd.int(120_000));
      const ci = rnd.int(n);
      const c = clients[ci]!;
      const existing = await localFiles(c);
      const roll = rnd.float();
      let acc = 0;
      let op = 'sync';
      for (const [name, weight] of OPS) {
        acc += weight;
        if (roll < acc) {
          op = name;
          break;
        }
      }
      /** Records the operation as run, and as an effect unless changed is false. */
      const did = (what: string, changed = true) => {
        ops[op] = (ops[op] ?? 0) + 1;
        if (changed) effects[op] = (effects[op] ?? 0) + 1;
        log.push(`${step} ${c.name} ${what}`);
      };

      switch (op) {
        case 'create': {
          const free = await freeAmong(c, universe);
          if (free.length === 0) break;
          const p = rnd.pick(free);
          const t = token(ci);
          await c.adapter.write(p, payload(p, t));
          did(`create ${p} ${t}`);
          break;
        }
        case 'edit': {
          if (existing.length === 0) break;
          const p = rnd.pick(existing);
          did(await userEdit(c, ci, p, (await c.adapter.read(p))!, rnd.float() < 0.3));
          break;
        }
        case 'edit-mid-cycle': {
          // The user saves p right after the engine read it in a cycle, so the
          // engine carries on with content that is already out of date. Half
          // the time p was edited just before (so the push reads it); else
          // only a pull, an apply or a reconcile in this cycle reads it.
          if (existing.length === 0) break;
          const p = rnd.pick(existing);
          const replace = rnd.float() < 0.5;
          if (rnd.float() < 0.5) log.push(`${step} ${c.name} ${await userEdit(c, ci, p, (await c.adapter.read(p))!, false)} (before the cycle)`);
          const adapter = c.adapter;
          const read = adapter.read;
          const fold = (q: string) => (adapter.caseInsensitive ? caseFold(q) : q);
          let edited: string | null = null;
          adapter.read = async (path: string) => {
            const data = await read.call(adapter, path);
            if (edited === null && data !== null && fold(path) === fold(p)) edited = await userEdit(c, ci, path, data, replace);
            return data;
          };
          try {
            await c.engine.runCycle();
          } finally {
            adapter.read = read;
          }
          if (edited === null) did(`edit of ${p} during a cycle: the cycle did not read it`, false);
          else did(`${edited} (during a cycle, right after the engine read it)`);
          break;
        }
        case 'rename': {
          // Renames keep the kind (text or binary), so token checks stay meaningful.
          if (existing.length === 0) break;
          const src = rnd.pick(existing);
          const free = await freeAmong(c, universe.filter((p) => isBinary(p) === isBinary(src)));
          if (free.length === 0) break;
          const dst = rnd.pick(free);
          noteRemoval(src);
          await c.adapter.rename(src, dst);
          did(`rename ${src} -> ${dst}`);
          break;
        }
        case 'case-rename': {
          if (!caseOps || existing.length === 0) break;
          const src = rnd.pick(existing);
          // On a case-insensitive device only the file name's case can change
          // (the folder keeps its name); on a case-sensitive one the folder's
          // case can too, which moves the file to another folder.
          const dst = !c.adapter.caseInsensitive && src.includes('/') && rnd.float() < 0.5 ? folderCaseVariant(src) : caseVariant(src);
          if (dst === src) break;
          // On a case-sensitive device the new name must be free; on a case-insensitive one it is the same file.
          if (!c.adapter.caseInsensitive && !(await placeFree(c, dst))) break;
          noteRemoval(src);
          if (CONFLICT_COPY_PATTERN.test(src)) renamedCopies.add(dst);
          await c.adapter.rename(src, dst);
          did(`case-rename ${src} -> ${dst}`);
          break;
        }
        case 'delete': {
          if (existing.length === 0) break;
          const p = rnd.pick(existing);
          for (const x of tokensIn((await c.adapter.read(p))!)) removed.add(x);
          noteRemoval(p);
          await c.adapter.remove(p);
          did(`delete ${p}`);
          break;
        }
        case 'network':
          c.net.setOnline(!c.net.online);
          did(c.net.online ? 'online' : 'offline');
          break;
        case 'lose-commit':
          armedLosses.push(c.net.loseNextResponse('POST', '/commit'));
          did('will lose a commit response', false);
          break;
        case 'crash-after-commit': {
          // The commit reaches the server, its answer does not, and the app restarts before it can find out.
          const lost = c.net.loseNextResponse('POST', '/commit');
          await c.engine.runCycle();
          await c.restart();
          did(lost.fired ? 'crash after commit' : 'crash after a cycle that committed nothing', lost.fired);
          break;
        }
        case 'restart':
          await c.restart();
          did('restart');
          break;
        case 'history-restore': {
          if (!c.net.online || existing.length === 0) break;
          const p = rnd.pick(existing);
          const history = await unlessNetworkFails(() => fileHistory(c.api, c.ring, p));
          if (history === null) {
            log.push(`${step} ${c.name} history of ${p} not loaded: network error`);
            break;
          }
          const older = history.slice(1).filter((e) => !e.version.deleted && e.meta);
          if (older.length === 0) break;
          const entry = rnd.pick(older);
          const before = tokensIn((await c.adapter.read(p)) ?? new Uint8Array(0));
          try {
            await restore(c.api, c.ring, c.adapter, c.state, entry);
          } catch (err) {
            if (!isExpectedRestoreError(err)) throw err;
            log.push(`${step} ${c.name} history restore of ${p} refused: ${(err as Error).name}`);
            break;
          }
          await noteRemovedTokens(c, p, before);
          did(`restore ${p} to ${entry.versionId.slice(0, 8)}`);
          break;
        }
        case 'trash-restore': {
          if (!c.net.online) break;
          const trash = await unlessNetworkFails(() => listTrash(c.api, c.ring));
          if (trash === null) {
            log.push(`${step} ${c.name} trash not loaded: network error`);
            break;
          }
          if (trash.length === 0) break;
          const entry = rnd.pick(trash);
          const p = entry.meta?.path;
          const before = p ? tokensIn((await c.adapter.read(p)) ?? new Uint8Array(0)) : [];
          try {
            await restore(c.api, c.ring, c.adapter, c.state, entry);
          } catch (err) {
            if (!isExpectedRestoreError(err)) throw err;
            log.push(`${step} ${c.name} trash restore of ${p ?? '?'} refused: ${(err as Error).name}`);
            break;
          }
          if (p) await noteRemovedTokens(c, p, before);
          did(`restore ${p ?? '?'} from the trash`);
          break;
        }
        case 'ignore':
          await c.setIgnore(c.ignoreGlobs.length > 0 ? [] : ['Scratch/']);
          did(c.ignoreGlobs.length > 0 ? 'ignore Scratch/' : 'stop ignoring');
          break;
        case 'backup':
          backup = await srv.snapshot();
          did('backup of the server');
          break;
        case 'hot-backup':
          backup = await srv.hotSnapshot();
          did('hot backup of the running server');
          break;
        case 'restore-backup':
          if (backup === null) break;
          await srv.restore(backup);
          did('restore of the server from its backup');
          break;
        default: {
          const commitsBefore = c.net.count('POST', '/commit');
          const eventsBefore = c.events.length;
          await c.engine.runCycle();
          const applied = c.events.slice(eventsBefore).some((e) => e.type === 'remote-change' || e.type === 'conflict' || e.type === 'merged' || e.type === 'notice');
          const changed = applied || c.net.count('POST', '/commit') > commitsBefore;
          did(changed ? 'sync' : 'sync (nothing to do)', changed);
        }
      }
      collectCopies(step);
      await scanCopies(step);
    }

    for (const c of clients) c.net.setOnline(true);
    for (const c of clients) if (c.ignoreGlobs.length > 0) await c.setIgnore([]); // everything syncs again
    await settle(clients, 40);
    collectCopies(steps);
    await scanCopies(steps);
    effects['lose-commit'] = armedLosses.filter((l) => l.fired).length;
    if (effects['lose-commit'] === 0) delete effects['lose-commit'];

    const snaps = clients.map((c) => c.adapter.snapshot());
    const first = snaps[0]!;
    const sorted = (m: Map<string, Uint8Array>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const show = (m: Map<string, Uint8Array>) => sorted(m).map(([p, d]) => `${p} (${d.length} bytes) ${latin1.decode(d.subarray(0, 120)).replace(/\n/g, '\\n')}`).join('\n');
    const digest = async (m: Map<string, Uint8Array>) => {
      const out: string[] = [];
      for (const [p, d] of sorted(m)) out.push(`${p} ${await hashHex(d)}`);
      return out.join('\n');
    };
    /** What every device's state says about the paths on which vaults differ, for a failing seed's message. */
    const recordsFor = async (paths: Iterable<string>) => {
      const out: string[] = [];
      for (const p of paths) {
        for (const c of clients) {
          for (const r of await c.state.filesByPath(p)) out.push(`${c.name} ${p}: ${JSON.stringify({ ...r, fileId: r.fileId.slice(0, 8), contentHash: r.contentHash?.slice(0, 8) })}`);
        }
      }
      const serverSeq = (await clients[0]!.api.changes(clients[0]!.vaultId, 0, 1)).vaultSeq;
      for (const c of clients) out.push(`${c.name}: cursor ${await c.state.getCursor()} anchor ${JSON.stringify(await c.state.getCursorAnchor())} (server seq ${serverSeq})`);
      return out.join('\n');
    };
    const firstDigest = await digest(first);
    for (let i = 1; i < snaps.length; i++) {
      if ((await digest(snaps[i]!)) !== firstDigest) {
        const differing = new Set<string>();
        for (const p of new Set([...first.keys(), ...snaps[i]!.keys()])) {
          const a = first.get(p);
          const b = snaps[i]!.get(p);
          if (!a || !b || !equalBytes(a, b)) differing.add(p);
        }
        throw new Error(`seed ${o.seed} (${label}): ${clients[i]!.name} differs from dev0\n--- dev0\n${show(first)}\n--- ${clients[i]!.name}\n${show(snaps[i]!)}\n--- state of the differing paths\n${await recordsFor(differing)}\n--- log\n${log.join('\n')}`);
      }
    }
    const seqs = await Promise.all(clients.map((c) => c.state.getCursor()));
    const serverSeq = (await clients[0]!.api.changes(clients[0]!.vaultId, 0, 1)).vaultSeq;
    if (seqs.some((s) => s !== serverSeq)) throw new Error(`seed ${o.seed} (${label}): cursors ${seqs} != server seq ${serverSeq}\n--- log\n${log.join('\n')}`);

    const present = new Set([...first.values()].flatMap((d) => tokensIn(d)));
    const lost = [...written].filter((t) => !present.has(t) && !removed.has(t));
    if (lost.length > 0) throw new Error(`seed ${o.seed} (${label}): lost edits ${lost.join(', ')}\n--- final\n${show(first)}\n--- log\n${log.join('\n')}`);

    // Copies come from merge conflicts (conflict events) and from collisions (notices that name the copy).
    const copies = [...first.keys()].filter((p) => CONFLICT_COPY_PATTERN.test(p));
    const reported = new Set(clients.flatMap((c) => c.events.flatMap((e) => {
      if (e.type === 'conflict') return [e.conflictPath];
      if (e.type === 'notice' && e.conflictPath !== undefined) return [e.conflictPath];
      return [];
    })));
    const unexplained = copies.filter((p) => !reported.has(p) && !renamedCopies.has(p));
    if (unexplained.length > 0) throw new Error(`seed ${o.seed} (${label}): conflict copies without an event: ${unexplained.join(', ')}\n--- final\n${show(first)}\n--- log\n${log.join('\n')}`);

    const finalNames = new Set([...first.keys()].map(foldName));
    const missingCopies = copiesSeen.filter((cp) => !finalNames.has(foldName(cp.path)) && !copyRemovals.some((r) => foldName(r.path) === foldName(cp.path) && r.step > appearedAt(cp.path, cp.step)));
    if (missingCopies.length > 0) {
      const what = missingCopies.map((cp) => `${cp.path} (${cp.kind} copy seen on ${cp.device} at step ${cp.step})`).join(', ');
      throw new Error(`seed ${o.seed} (${label}): copies reported by an event are gone: ${what}\n--- final\n${show(first)}\n--- log\n${log.join('\n')}`);
    }

    const server = await serverFiles(clients[0]!.api, clients[0]!.ring);
    const describeHashes = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, h]) => `${p} ${h}`).join('\n');
    for (let i = 0; i < snaps.length; i++) {
      const local = new Map<string, string>();
      for (const [p, d] of snaps[i]!) local.set(p, await hashHex(d));
      if (describeHashes(local) !== describeHashes(server)) {
        throw new Error(`seed ${o.seed} (${label}): ${clients[i]!.name} differs from the server's live heads\n--- server\n${describeHashes(server)}\n--- ${clients[i]!.name}\n${describeHashes(local)}\n--- log\n${log.join('\n')}`);
      }
    }

    ok = true;
    return { seed: o.seed, fleet, coarseMtime: coarse, files: first.size, conflictCopies: copies.length, tokens: written.size, ops, effects, log };
  } finally {
    let stopError: unknown = null;
    for (const c of clients) {
      try {
        await c.engine.stop();
      } catch (err) {
        stopError ??= err;
      } finally {
        c.state.close();
      }
    }
    if (ok && stopError) throw stopError;
  }
}

/** The server's live files: path → content hash (hex), from each live head's decrypted metadata. */
async function serverFiles(api: ApiClient, ring: VaultKeyring): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: Uint8Array | null = null;
  for (;;) {
    const page = await api.heads(ring.vaultId, after);
    for (const h of page.heads) {
      if (h.deleted) continue;
      const v = (await api.history(ring.vaultId, h.fileId)).find((x) => equalBytes(x.versionId, h.versionId));
      if (!v) throw new Error(`head ${toHex(h.versionId)} of ${toHex(h.fileId)} is not in its history`);
      const meta = await decryptMeta(ring, v.epoch, v.fileId, v.versionId, v.encMeta);
      if (out.has(meta.path)) throw new Error(`two live heads claim ${meta.path}`);
      out.set(meta.path, toHex(meta.contentHash));
    }
    if (!page.more || page.heads.length === 0) return out;
    after = page.heads[page.heads.length - 1]!.fileId;
  }
}

/** Seeds to run: OBSYNC_CONVERGENCE_SEED replays one; else OBSYNC_CONVERGENCE_SEEDS (default 20) starting at 1. */
export function seedsFromEnv(env: Record<string, string | undefined>): number[] {
  if (env['OBSYNC_CONVERGENCE_SEED']) return [Number(env['OBSYNC_CONVERGENCE_SEED'])];
  const count = Number(env['OBSYNC_CONVERGENCE_SEEDS'] ?? '20');
  const start = Number(env['OBSYNC_CONVERGENCE_FIRST_SEED'] ?? '1');
  return Array.from({ length: count }, (_, i) => start + i);
}
