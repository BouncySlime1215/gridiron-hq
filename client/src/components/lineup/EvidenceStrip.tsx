import type { Career, Preseason } from '../draft/types';
import EvidenceTable from '../draft/EvidenceTable';
import StreakChips from '../draft/StreakChips';

/**
 * The record behind a name on the lineup and league-brain pages.
 *
 * The weekly projection decides the call; this is what the projection cannot
 * say — how often the man actually posted a startable week last season, where
 * his floor sits, what the preseason band was, and whether his situation moved
 * over the summer. Every field is optional: a rookie with no record renders
 * nothing rather than a strip of dashes.
 */
export interface PlayerEvidence {
  headline?: string | null;
  career?: Career | null;                       // full form only
  consistency?: { seasons_counted?: number | null; seasons_top24?: number | null; seasons_top12?: number | null } | null; // compact form
  last_season?: { season: number; games?: number | null; points?: number | null; ppg?: number | null; pos_rank?: number | null } | null;
  weekly?: { season: number; games: number; ppg: number | null; floor: number | null; ceiling: number | null; games_15plus: number } | null;
  preseason?: Preseason | null;
  offseason?: { opportunity_multiplier?: number | null; confidence?: string | null; drivers?: string[]; risk?: boolean } | null;
}

const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));

/** "top-12 in 2 of 4 seasons", from whichever form of the consistency counts is present. */
function consistencyText(ev: PlayerEvidence): string | null {
  const c = ev.career?.consistency ?? ev.consistency;
  const n = ev.consistency?.seasons_counted ?? ev.career?.seasons?.length ?? null;
  if (!c || !n) return null;
  if (c.seasons_top12) return `top-12 in ${c.seasons_top12} of ${n}`;
  if (c.seasons_top24) return `top-24 in ${c.seasons_top24} of ${n}`;
  return `${n} season${n === 1 ? '' : 's'} on record`;
}

/**
 * One line, for lists: the headline, the preseason band, and a risk chip when
 * the offseason model moved him down. Used on the bench and across League Brain.
 */
export function RecordLine({ ev, className = '' }: { ev?: PlayerEvidence | null; className?: string }) {
  if (!ev) return null;
  const band = ev.preseason?.p20 != null && ev.preseason?.p80 != null
    ? `${Math.round(ev.preseason.p20)}–${Math.round(ev.preseason.p80)} pts` : null;
  const floor = ev.weekly?.floor != null ? `floor ${fmt(ev.weekly.floor)} / ceiling ${fmt(ev.weekly.ceiling)}` : null;
  if (!ev.headline && !band && !floor && !ev.offseason?.risk) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-slate-500 ${className}`}>
      {ev.headline && <span className="min-w-0 break-words font-medium text-slate-700">{ev.headline}</span>}
      {floor && <span className="tabular-nums">{floor}</span>}
      {band && <span className="tabular-nums">preseason {band}</span>}
      {ev.offseason?.risk && <RiskChip offseason={ev.offseason} />}
    </div>
  );
}

function RiskChip({ offseason }: { offseason: NonNullable<PlayerEvidence['offseason']> }) {
  return (
    <span title={offseason.drivers?.join(' · ') || 'Offseason opportunity read is down'}
      className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-900">
      offseason ×{fmt(offseason.opportunity_multiplier, 2)}{offseason.confidence ? ` · ${offseason.confidence}` : ''}
    </span>
  );
}

/**
 * The full strip for a start/sit candidate: headline, then Floor / Ceiling /
 * Consistency tiles, the preseason band, streak chips, and a collapsed
 * season-by-season table behind a disclosure. Stacks cleanly at 375px — the
 * tiles are a three-column grid, never a row that has to overflow.
 */
export default function EvidenceStrip({ ev, position, name }:
  { ev?: PlayerEvidence | null; position?: string; name?: string }) {
  if (!ev) return null;
  const w = ev.weekly;
  const cons = consistencyText(ev);
  const band = ev.preseason?.p20 != null && ev.preseason?.p80 != null;
  const hasTiles = !!w || !!cons || !!ev.last_season;
  if (!ev.headline && !hasTiles && !band && !ev.offseason) return null;

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">
          The record{name ? ` · ${name}` : ''}
        </span>
        {w && <span className="text-[10px] text-slate-400">{w.season} weekly, {w.games} games</span>}
      </div>
      {ev.headline && <p className="mt-1 text-sm font-semibold leading-5 text-slate-800">{ev.headline}</p>}

      {hasTiles && (
        <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-slate-200 ring-1 ring-slate-200">
          <Tile label="Floor" value={fmt(w?.floor)} hint={w ? '20th pct week' : 'no gamelog'} />
          <Tile label="Ceiling" value={fmt(w?.ceiling)} hint={w ? '80th pct week' : 'no gamelog'} />
          <Tile label="Consistency"
            value={w ? `${w.games_15plus}/${w.games}` : cons ?? '—'}
            hint={w ? 'weeks at 15+' : cons ? 'seasons' : 'no record'} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        {ev.last_season && (
          <span className="tabular-nums">
            {ev.last_season.season}: <b className="text-slate-800">{fmt(ev.last_season.ppg)}</b> ppg
            {ev.last_season.games != null && ` · ${ev.last_season.games} g`}
            {ev.last_season.pos_rank != null && ` · ${position ?? ''}${ev.last_season.pos_rank}`}
          </span>
        )}
        {w && cons && <span className="tabular-nums">{cons}</span>}
        {band && (
          <span className="tabular-nums">
            preseason <b className="text-slate-800">{Math.round(ev.preseason!.p20!)}–{Math.round(ev.preseason!.p80!)}</b> pts
            {ev.preseason?.expected_games != null && ` · ~${Math.round(ev.preseason.expected_games)} g`}
          </span>
        )}
        {ev.offseason?.risk && <RiskChip offseason={ev.offseason} />}
      </div>

      {ev.career && <div className="mt-2"><StreakChips career={ev.career} compact /></div>}

      {(ev.career?.seasons?.length ?? 0) > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-sky-700">Season by season</summary>
          <div className="mt-2">
            <EvidenceTable career={ev.career} preseason={ev.preseason} position={position} />
          </div>
        </details>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 bg-white px-2 py-1.5 text-center">
      <div className="text-[9px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="truncate text-sm font-black tabular-nums text-slate-900">{value}</div>
      <div className="truncate text-[9px] text-slate-400">{hint}</div>
    </div>
  );
}
