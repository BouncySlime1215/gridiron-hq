/**
 * WAR-ROOM-UI v2: the hero card's status badge, read only from fields the view already
 * serves (the step's p_yes, title_odds_delta, title_after). No number is computed here.
 *
 *  - green "Safe to send": no shown number is a guess (`guess: true`) and the title-odds
 *    change clears 2 SE (`clears_2se: true`);
 *  - red "Don't send yet": a shown number failed its check;
 *  - amber "Not yet": anything else, with the shortest reason on the badge and every
 *    reason in its tooltip.
 */
import type { Field } from './types';
import type { Step } from './cardParts';

export type HeroTone = 'green' | 'amber' | 'red';
export interface HeroStatus { tone: HeroTone; label: string; reasons: string[] }

export const SAFE_TO_SEND = 'Safe to send';

/** `guess: true` on a served field (plans-schema.js FIELD_META); the client type predates it. */
export const isGuess = (f: Field<unknown> | undefined | null): boolean =>
  !!f && (f as { guess?: unknown }).guess === true;

const shortest = (xs: string[]) => xs.reduce((a, b) => (b.length < a.length ? b : a));

export function heroStatus(s: Pick<Step, 'p_yes' | 'title_odds_delta' | 'title_after'>): HeroStatus {
  const red: string[] = [];
  const amber: string[] = [];
  const read = (f: Field<unknown> | undefined, name: string, required: boolean) => {
    if (!f) { if (required) amber.push(`${name} not computed`); return; }
    if (f.status === 'failed') { red.push(`${name} failed its check`); return; }
    if (f.status !== 'ok' || f.value === undefined) { if (required) amber.push(`${name} not computed`); return; }
    if (isGuess(f)) amber.push(`${name} is a guess`);
  };
  read(s.p_yes, 'chance', true);
  read(s.title_odds_delta, 'gain', true);
  read(s.title_after, 'odds after', false);
  const d = s.title_odds_delta;
  if (d && d.status === 'ok' && d.value !== undefined) {
    if (d.clears_2se === false) amber.push('gain inside the noise');
    else if (d.clears_2se !== true) amber.push('gain has no noise check');
  }
  if (red.length) return { tone: 'red', label: `Don't send: ${shortest(red)}`, reasons: [...red, ...amber] };
  if (amber.length) return { tone: 'amber', label: `Not yet: ${shortest(amber)}`, reasons: amber };
  return { tone: 'green', label: SAFE_TO_SEND, reasons: [] };
}

/** "Josh Allen (QB)" -> { name: 'Josh Allen', pos: 'QB' }; anything else stays whole. Text only. */
export function playerParts(label: string): { name: string; pos: string | null } {
  const m = /^(.*\S)\s+\(([A-Z/]{1,4})\)$/.exec(label);
  return m ? { name: m[1], pos: m[2] } : { name: label, pos: null };
}

/**
 * The his-screen market read as Nick's value edge, in words and a signed label. `pct` is
 * his side's market % (his_get vs his_give, his-screen.js): positive = Nick pays over
 * market. Formatting only: the sign is flipped in the text, no value is recomputed.
 */
export function valueEdgeText(pct: number): { big: string; note: string; tone: HeroTone } {
  const mag = Math.abs(pct).toFixed(0);
  if (mag === '0') return { big: '±0%', note: 'even on market value', tone: 'green' };
  return pct > 0
    ? { big: `−${mag}%`, note: `you pay ${mag}% over market`, tone: 'amber' }
    : { big: `+${mag}%`, note: `you get ${mag}% more market value`, tone: 'green' };
}
