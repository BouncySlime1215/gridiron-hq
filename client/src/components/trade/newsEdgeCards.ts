/** Cards shown before "Show all": the freshest few keep the area near one phone screen. */
export const FIRST = 5;

/**
 * One card per move: the route lists every news item, so the same move (say, "claim X") can come from
 * two reports. The list is freshest first; the first card for a move stays and the later reports are
 * counted on it. Presentation only: nothing is re-ranked or scored.
 */
export function oneCardPerMove<T extends { action: { kind: string; target?: string } }>(list: T[]): (T & { more_reports: number })[] {
  const out: (T & { more_reports: number })[] = [];
  const at = new Map<string, number>();
  for (const o of list) {
    const key = `${o.action.kind}|${o.action.target ?? ''}`;
    const i = at.get(key);
    if (i == null) { at.set(key, out.length); out.push({ ...o, more_reports: 0 }); }
    else out[i].more_reports += 1;
  }
  return out;
}
