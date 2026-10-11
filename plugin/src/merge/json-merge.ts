// Merging Obsidian's settings files (spec 2026-10-11-settings-layer-design,
// D6). A line merge of pretty-printed JSON can come out "clean" and not be
// JSON (two edits around one comma), which would silently break Obsidian's
// settings, and a conflict copy in the config folder is a file nobody sees.
// So settings files merge by top-level key: a key changed on one side takes
// that side's value, a key changed on both sides to different values takes
// the remote one. The result is always valid JSON.

type JsonObject = Record<string, unknown>;

function parseObject(text: string): JsonObject | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

/** Structural equality of two JSON values (key order does not matter). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same((a as JsonObject)[k], (b as JsonObject)[k]));
}

const has = (o: JsonObject, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Merges two versions of a settings file against their common base, key by
 * key at the top level; a key removed on one side and unchanged on the
 * other is removed. base null (no common version) counts as an empty
 * object. Returns null when ours, theirs or a given base is not a JSON
 * object: the caller then takes theirs whole. Otherwise the merged object
 * as Obsidian writes it (two-space indent), keys in theirs' order and then
 * ours' new ones.
 */
export function mergeJsonSettings(base: string | null, ours: string, theirs: string): string | null {
  const b = base === null ? {} : parseObject(base);
  const o = parseObject(ours);
  const t = parseObject(theirs);
  if (!b || !o || !t) return null;
  const out: JsonObject = {};
  const keys = [...Object.keys(t), ...Object.keys(o).filter((k) => !has(t, k)), ...Object.keys(b).filter((k) => !has(t, k) && !has(o, k))];
  for (const k of keys) {
    const inB = has(b, k);
    const inO = has(o, k);
    const inT = has(t, k);
    const oursChanged = inO !== inB || (inO && !same(o[k], b[k]));
    const theirsChanged = inT !== inB || (inT && !same(t[k], b[k]));
    // Unchanged here, or changed on both sides: the remote side wins. Changed only here: ours.
    const [present, value] = oursChanged && !theirsChanged ? [inO, o[k]] : [inT, t[k]];
    if (present) out[k] = value;
  }
  return JSON.stringify(out, null, 2);
}
