import { useState } from 'react';
import { useHisScreen } from './useWarRoom';

/**
 * HIS-SCREEN (WAR-ROOM-UI.md v3, mode 2): one offer the way the partner sees it.
 * His roster before and after, each player priced his way next to ours (his
 * clone), what he gives up, his title-odds change, and the "fair on his screen"
 * badge. Reads GET /api/trades/:leagueId/his-screen; default-off on the server,
 * HIS-SCREEN-FIX: a War Room deck move is precomputed by the planner (the route only
 * reads it, `precomputed.as_of`); any other offer is worked out once off the web
 * server's main thread (`computed_off_thread`), so the first open can take seconds.
 * so an off flag renders its reason, and every unknown field renders its reason
 * instead of a number.
 */

type Field<T> = { status: 'ok' | 'unknown'; value?: T; reason?: string; source: string; se?: number; clears_2se?: boolean; multiplier?: number };
type Row = {
  id: string; name: string; position: string | null; ros_ppg: number | null;
  value_ours: number; value_his: Field<number>; reasons: string[];
  move?: 'leaves' | 'arrives'; fills_need?: boolean;
};
type Fair = { verdict: 'fair' | 'short' | 'rich'; pct: number; window: { low: number; high: number }; text: string };
type ValueView = { his_give: number | null; his_get: number | null; pct: number | null; market_pct: number | null; informed: boolean; basis: string };
export type HisScreenData = {
  enabled: boolean; reason?: string; error?: string; preview?: boolean; preview_reason?: string;
  partner?: string;
  roster?: { before: Row[]; after: Row[]; counts_before: Record<string, number>; counts_after: Record<string, number> };
  gives_up?: Row[]; gets?: Row[];
  market?: { his_give: number; his_get: number; pct: number | null };
  value_view?: Field<ValueView>;
  title_odds?: Field<{ before: number; after: number; delta: number }>;
  fair?: Field<Fair>;
  precomputed?: { as_of: string; plans_generated_at: string | null };
  computed_off_thread?: boolean; cached?: boolean;
};

export type Offer = { partner: string; give: string[]; get: string[] };

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const pctS = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`);
const odds = (v: number) => `${(v * 100).toFixed(1)}%`;

export function hisScreenPath(leagueId: string | number, o: Offer) {
  const q = new URLSearchParams({ partner: o.partner, give: o.give.join(','), get: o.get.join(',') });
  return `/trades/${leagueId}/his-screen?${q.toString()}`;
}

const BADGE_TONE: Record<Fair['verdict'], string> = {
  fair: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  short: 'border-red-300 bg-red-50 text-red-800',
  rich: 'border-amber-300 bg-amber-50 text-amber-800',
};

export function FairBadge({ fair }: { fair?: Field<Fair> }) {
  if (!fair) return null;
  if (fair.status !== 'ok' || !fair.value) {
    return (
      <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600" title={fair.reason}>
        His screen: unknown
      </span>
    );
  }
  const f = fair.value;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${BADGE_TONE[f.verdict]}`} title={f.text}>
      {f.verdict === 'fair' ? 'Fair on his screen' : f.verdict === 'short' ? 'Short on his screen' : 'Rich on his screen'} {pctS(f.pct)}
    </span>
  );
}

function HisValue({ v }: { v: Field<number> }) {
  if (v.status !== 'ok' || v.value == null) return <span className="text-[var(--subtle)]" title={v.reason}>—</span>;
  return <span className="tabular-nums">{n0(v.value)}</span>;
}

function RosterList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--subtle)]">{title}</div>
      <ul className="mt-1 space-y-0.5">
        {rows.map(r => (
          <li key={r.id} className={`flex items-baseline gap-2 text-[12px] ${r.move === 'leaves' ? 'text-crit line-through' : r.move === 'arrives' ? 'text-good font-semibold' : ''}`}>
            <span className="w-8 shrink-0 text-[10px] text-[var(--muted)]">{r.position ?? '?'}</span>
            <span className="min-w-0 flex-1 truncate">{r.name}{r.fills_need ? ' · fills a need' : ''}</span>
            <span className="text-[11px] text-[var(--muted)]" title="ours / his">{n0(r.value_ours)} / <HisValue v={r.value_his} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HisScreenView({ data }: { data: HisScreenData }) {
  if (!data.enabled) return <p className="text-[12px] text-[var(--muted)]">{data.reason}</p>;
  if (data.error) return <p className="text-[12px] text-crit" role="alert">His screen could not be built: {data.error}</p>;
  const vv = data.value_view, t = data.title_odds;
  return (
    <section className="space-y-3" aria-label="His screen">
      {data.preview && <p className="text-[11px] text-amber-700">Preview (unconfirmed forward): {data.preview_reason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold">Team {data.partner}&rsquo;s screen</span>
        <FairBadge fair={data.fair} />
        {data.fair?.status !== 'ok' && <span className="text-[11px] text-[var(--muted)]">{data.fair?.reason}</span>}
      </div>

      <div className="grid gap-2 text-[12px] sm:grid-cols-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--subtle)]">He gives up</div>
          {(data.gives_up ?? []).map(r => <div key={r.id}>{r.name} <span className="text-[var(--muted)]">({n0(r.value_ours)} / <HisValue v={r.value_his} />)</span></div>)}
          {!(data.gives_up ?? []).length && <div className="text-[var(--muted)]">nothing</div>}
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--subtle)]">His value view</div>
          {vv?.status === 'ok' && vv.value
            ? <div className="tabular-nums">gets {n0(vv.value.his_get)} for {n0(vv.value.his_give)}: <b>{pctS(vv.value.pct)}</b>
                <span className="text-[var(--muted)]"> (market {pctS(vv.value.market_pct)})</span>
                <div className="text-[11px] text-[var(--muted)]">{vv.value.basis}</div></div>
            : <div className="text-[var(--muted)]">{vv?.reason} Market: {pctS(data.market?.pct)}.</div>}
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--subtle)]">His title odds</div>
          {t?.status === 'ok' && t.value
            ? <div className="tabular-nums">{odds(t.value.before)} → {odds(t.value.after)} (<b>{t.value.delta >= 0 ? '+' : ''}{(t.value.delta * 100).toFixed(1)} pts</b>)
                {t.se != null && <span className="text-[var(--muted)]"> ±{(t.se * 100).toFixed(1)} SE{t.clears_2se ? '' : ', inside noise'}</span>}</div>
            : <div className="text-[var(--muted)]">{t?.reason}</div>}
        </div>
      </div>

      {data.roster && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <RosterList title="His roster now" rows={data.roster.before} />
          <RosterList title="After the offer" rows={data.roster.after} />
        </div>
      )}
      <p className="text-[10px] text-[var(--subtle)]">Values: ours / his (his clone&rsquo;s read). Badge window from the trade finder.
        {data.precomputed ? ` Worked out by the planner ${new Date(data.precomputed.as_of).toLocaleString()}.` : ''}</p>
    </section>
  );
}

/** Fetching wrapper: pass any offer in Nick's terms (give = what Nick sends). */
export default function HisScreen({ leagueId, offer }: { leagueId: string | number; offer: Offer | null }) {
  const { data, loading, error } = useHisScreen(offer ? hisScreenPath(leagueId, offer) : null);
  if (!offer) return null;
  if (loading && !data) return <p className="text-[12px] text-[var(--muted)]">Loading his screen… (an offer the planner did not score takes a few seconds)</p>;
  if (error) return <p className="text-[12px] text-crit" role="alert">His screen failed to load: {error}</p>;
  return data ? <HisScreenView data={data} /> : null;
}

/** War Room deck card: "His screen" toggle for the card's step (the offer Nick would send). */
export function HisScreenToggle({ leagueId, offer }: { leagueId: string | number; offer: Offer }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wr-his" data-testid="his-screen-toggle">
      <button type="button" className="wr-btn wr-sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {open ? 'Hide his screen' : 'His screen'}
      </button>
      {open && <div className="mt-2"><HisScreen leagueId={leagueId} offer={offer} /></div>}
    </div>
  );
}
