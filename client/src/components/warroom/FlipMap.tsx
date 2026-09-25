import { useState } from 'react';
import type { Field, Flip } from './types';
import { namer, teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, whole } from './format';
import { usePager } from './Panel';
import Avatar from './Avatar';

/** One player's flips: the best leg (first with fair legs, else the producer's first) and the rest. */
export interface FlipGroup { player: string; best: Flip; rows: Flip[]; actionable: boolean }

/**
 * WR-POLISH (audit defect 3): one row per player, in the producer's order (no client
 * sort). The best leg is the first row with fair legs on both screens, else the
 * producer's first (biggest gap). Players with no fair leg anywhere are not actionable.
 */
export function groupFlips(list: Flip[]): FlipGroup[] {
  const by = new Map<string, Flip[]>();
  for (const f of list) {
    const k = String(f.player);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(f);
  }
  return [...by.entries()].map(([player, rows]) => {
    const withLegs = rows.find(r => r.legs);
    return { player, rows, best: withLegs ?? rows[0], actionable: !!withLegs };
  });
}

/** `flip_map`: biggest buy-from-A / sell-to-B gaps, grouped by player; non-actionable rows behind "Show all". */
export default function FlipMap({ field, names, big }: { field: Field<Flip[]> | undefined; names?: Record<string, string>; big: boolean }) {
  const rows = field?.status === 'ok' && field.value ? field.value : [];
  const [all, setAll] = useState(false);
  const groups = groupFlips(rows);
  const shown = all ? groups : groups.filter(g => g.actionable);
  const hiddenCount = groups.length - groups.filter(g => g.actionable).length;
  const pg = usePager(shown.length, big ? 9 : 4);
  const n = namer(names);
  const whyNot = (f: Flip) => f.legs_why_not ?? 'no fair legs found';
  // FLIP-LEGS-2: the whole package each leg asks for ('X + Y'), else the one id the producer served.
  const legText = (f: Flip) => {
    if (!f.legs) return null;
    const give = n.text(f.legs.give_a_ids?.length ? f.legs.give_a_ids : [f.legs.give_a]);
    const get = n.text(f.legs.get_b_ids?.length ? f.legs.get_b_ids : [f.legs.get_b]);
    return <span className="wr-muted" data-testid="flip-legs">give {give} → get {get}</span>;
  };
  // RADAR-WIRE: the why-now label, with its status word first ("Check first" / "Why now" / "Watch").
  const WHY_WORD: Record<string, string> = { act: 'Why now', watch: 'Watch', check_first: 'Check first', none: 'Why now' };
  const whyNow = (f: Flip) => (f.why_now
    ? <div className="wr-sub" data-testid="flip-why-now" data-why-status={f.why_now.status}>{WHY_WORD[f.why_now.status] ?? 'Why now'}: {f.why_now.text}</div>
    : null);
  const more = (g: FlipGroup) => (g.rows.length > 1 ? ` · +${g.rows.length - 1} other buyer${g.rows.length > 2 ? 's' : ''}` : '');
  const toggle = hiddenCount > 0 ? (
    <button type="button" className="wr-link" onClick={() => setAll(a => !a)} aria-expanded={all} data-testid="flip-show-all">
      {all ? 'Hide ones with no fair legs' : `Show all (${hiddenCount} with no fair legs yet)`}
    </button>
  ) : null;
  return (
    <FieldBlock f={field} label="Flip map">
      {list => !list.length ? <div className="wr-empty">No flips found in this run.</div> : (
        <>
          <div className="wr-row wr-sub">
            {big && <span>Buy low from one manager, sell high to another. Gap is in title-odds points.</span>}
            <span className="wr-sp" />{pg.control}
          </div>
          {!shown.length && (
            <div className="wr-empty" data-testid="flip-none-actionable">
              No flip has a fair leg on both sides yet: gaps on {groups.length} player{groups.length > 1 ? 's' : ''}, none sendable.
            </div>
          )}
          {shown.length > 0 && (big ? (
            <table className="wr-table">
              <thead><tr><th style={{ width: '24%' }}>Player</th><th>Buy from</th><th>Sell to</th><th>Gap</th><th>Prices</th><th>Both say yes</th></tr></thead>
              <tbody>
                {shown.slice(pg.a, pg.b).map(({ best: f, ...g }) => (
                  <tr key={g.player} data-flip-player={g.player}>
                    <td><Avatar id={f.player} name={n.one(f.player).name} size={32} /><b>{n.one(f.player).name}</b>{g.rows.length > 1 && <span className="wr-muted"> ×{g.rows.length}</span>}{f.legs && <div>{legText(f)}</div>}{whyNow(f)}</td>
                    <td>{teamLabel(f.buy_from)}</td><td>{teamLabel(f.sell_to)}</td>
                    <td className="wr-num"><Val f={f.spread} fmt={pts} showSe /></td>
                    <td className="wr-num"><Val f={f.price_a} fmt={whole} /> vs <Val f={f.price_b} fmt={whole} /></td>
                    <td className="wr-num">{f.legs ? <><Val f={f.legs.p_both} fmt={v => pct(v)} /> · you <Val f={f.legs.nick_after} fmt={pts} /></> : <span className="wr-muted" title={whyNot(f)}>{whyNot(f)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="wr-list">
              {shown.slice(pg.a, pg.b).map(g => {
                const f = g.best;
                return (
                  <li key={g.player} data-flip-player={g.player}>
                    <div className="wr-row"><Avatar id={f.player} name={n.one(f.player).name} size={32} /><b>{n.one(f.player).name}</b><span className="wr-sp" /><span className="wr-num">gap <Val f={f.spread} fmt={pts} /></span></div>
                    <div className="wr-sub">
                      Buy {teamLabel(f.buy_from)} → sell {teamLabel(f.sell_to)} · {f.legs ? <>both yes <Val f={f.legs.p_both} fmt={v => pct(v)} /></> : <span title={whyNot(f)}>no fair legs yet</span>}{more(g)}
                    </div>
                    {f.legs && <div className="wr-sub">{legText(f)}</div>}
                    {whyNow(f)}
                  </li>
                );
              })}
            </ul>
          ))}
          {toggle && <div className="wr-row">{toggle}</div>}
        </>
      )}
    </FieldBlock>
  );
}
