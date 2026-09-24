/**
 * FIX-02b: the effective model flags a producer run priced with, for `producer_version`.
 *
 * The refresh loop (which launches the producer) and the web server are separate
 * processes. If only one of them has preview mode on, Trade Lab and the War Room
 * price the same deal with different models. Writing the flags into the plans
 * file makes that mismatch visible instead of silent.
 *
 * Each flag is read through its own module's reader (none is re-read here). A reader
 * whose module or export is not merged yet reads 'absent', named, never guessed:
 *   rl16_1        trade-horizon.js#playoffImportance (measured weight on a 10/6 league)   PR #236
 *   rl17_3        season-sim.js#rosBasisFlag                                              PR #241
 *   title_mutual  title-mutual.js#titleMutualMode                                         PR #240
 *   preview       preview-mode.js#previewUnconfirmed
 */
import { previewUnconfirmed } from '../preview-mode.js';

/** RL-16-1 only changes the weight on this league shape; reading it there says whether it is on. */
const RL16_1_SHAPE = { teams: 10, playoffTeams: 6 };

const READERS = [
  ['rl16_1', '../trade-horizon.js', 'playoffImportance', f => {
    const r = f(RL16_1_SHAPE);
    return { on: r?.measured === true, preview: r?.preview === true };
  }],
  ['rl17_3', '../season-sim.js', 'rosBasisFlag', f => f()],
  ['title_mutual', '../title-mutual.js', 'titleMutualMode', f => f()],
];

/** The reader's own module is missing (not merged yet), not something it imports. */
const ownModuleMissing = (e, mod) => e?.code === 'ERR_MODULE_NOT_FOUND'
  && String(e.message).includes(`${mod.split('/').pop()}' imported from`);

/** 'on' | 'preview' (on only because of preview mode) | 'off' | 'absent'. */
const state = r => (!r ? 'absent' : r.on ? (r.preview ? 'preview' : 'on') : 'off');

/** { rl16_1, rl17_3, title_mutual, preview }, each a state string (preview: 'on' | 'off'). */
export async function modelFlags({ load = p => import(p) } = {}) {
  const out = {};
  for (const [key, mod, name, read] of READERS) {
    let m = null;
    try { m = await load(mod); } catch (e) {
      // Only a reader that is not merged yet is 'absent'; any other failure is a real fault.
      if (!ownModuleMissing(e, mod)) throw e;
    }
    out[key] = typeof m?.[name] === 'function' ? state(read(m[name])) : 'absent';
  }
  out.preview = previewUnconfirmed() ? 'on' : 'off';
  return out;
}

/** '1+rl16_1=off,rl17_3=preview,title_mutual=absent,preview=on': version, then the flags, in a fixed order. */
export function versionWithFlags(version, flags) {
  if (!flags) return String(version);
  return `${version}+${['rl16_1', 'rl17_3', 'title_mutual', 'preview'].map(k => `${k}=${flags[k] ?? 'absent'}`).join(',')}`;
}
