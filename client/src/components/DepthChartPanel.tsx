import { useState } from 'react';
import { useApi } from '../api';

/**
 * The depth chart, with the listing it came from named on the face of it.
 *
 * This app has three depth-chart sources and they are not interchangeable: a
 * weekly capture, a live Sleeper snapshot, and an opening-week ordering that
 * predates free agency and the draft. `teamDepthChart` picks the freshest one
 * that has the team; this panel's job is to say which one that was and when it
 * was taken, so a reader can tell a current ordering from a March one.
 *
 * Snap share sits beside the rank because it is the measurement that settles an
 * argument with a listing — but only where it describes the player. It counts
 * offensive snaps, so it says nothing about a defender or a specialist, and the
 * service marks that with `snap_share_basis` rather than a zero.
 */

type Basis = 'offensive_snaps' | 'not_measured' | 'not_applicable_to_this_position';

type DepthPlayer = {
  gsis_id: string;
  name: string;
  rank: number | null;
  snap_share: number | null;
  snap_share_basis: Basis;
};

type DepthChart = {
  team: string;
  season: number;
  week: number;
  source: string | null;
  captured: string | null;
  stale: boolean;
  unavailable_reason: string | null;
  positions: { pos: string; players: DepthPlayer[] }[];
};

/**
 * What to show in the snap-share column.
 *
 * Three different facts, and none of them is "0%": a measured share, a player
 * nobody measured this week, and a player this statistic cannot describe. The
 * em dash is for the last one deliberately — a blank cell invites the reader to
 * supply a zero, and a zero is the thing being avoided.
 */
function snapShareCell(p: DepthPlayer): { text: string; title: string } {
  if (p.snap_share_basis === 'not_applicable_to_this_position') {
    return { text: '—', title: 'Snap share here counts offensive snaps, which do not describe this position.' };
  }
  if (p.snap_share_basis === 'not_measured' || p.snap_share == null) {
    return { text: 'not measured', title: 'No snap row on file for this player this week.' };
  }
  return {
    text: `${Math.round(p.snap_share * 100)}%`,
    title: 'Share of the offensive snaps this player was on the field for.'
  };
}

function capturedLabel(captured: string | null): string {
  if (!captured) return 'capture time not recorded';
  const d = new Date(captured);
  return Number.isNaN(d.getTime()) ? `captured ${captured}` : `captured ${d.toLocaleDateString()}`;
}

export default function DepthChartPanel({ abbr, season, week }: {
  abbr: string; season?: number; week?: number;
}) {
  const query = [season ? `season=${season}` : '', week ? `week=${week}` : ''].filter(Boolean).join('&');
  const { data: chart, error } = useApi<DepthChart>(`/teams/${abbr}/depth-chart${query ? `?${query}` : ''}`);
  const [open, setOpen] = useState(false);

  // A failed request is not an absent depth chart. Rendering nothing here would
  // leave the page looking as though the team simply has no listing, which is a
  // different and much more reassuring claim than "we could not ask".
  if (error) {
    return (
      <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <b>Depth chart could not be loaded.</b> This is a failed request, not an empty depth chart —
        nothing was read, so nothing here should be taken as the team's current ordering.
      </div>
    );
  }

  if (!chart) return null;

  if (chart.unavailable_reason || !chart.positions?.length) {
    return (
      <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <b>No depth chart on file</b> for {chart.team} in {chart.season} week {chart.week}.
        {chart.unavailable_reason ? ` ${chart.unavailable_reason}` : ''}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white">
      <div className={`flex flex-wrap items-center gap-2 px-3 py-2 text-xs ${
        chart.stale ? 'bg-amber-50 text-amber-900' : 'text-slate-600'}`}>
        <b className="text-slate-900">Depth chart</b>
        <span>{chart.source ?? 'source not recorded'} · {capturedLabel(chart.captured)}</span>
        {chart.stale && (
          <span className="font-semibold">
            ⚠ This is an opening-week ordering. It predates free agency and the draft, so it is not
            this week's depth chart.
          </span>
        )}
        <button onClick={() => setOpen(v => !v)}
          className="ml-auto rounded-md border border-slate-300 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100">
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-200 px-3 py-2">
          <p className="mb-2 text-[11px] text-slate-500">
            A depth chart is a listing, not a measurement. Snap share is the measurement beside it, and it
            counts offensive snaps only — so it is shown as “—” where it cannot describe the position.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {chart.positions.map(group => (
              <div key={group.pos}>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{group.pos}</div>
                <ol className="space-y-0.5">
                  {group.players.map(p => {
                    const cell = snapShareCell(p);
                    return (
                      <li key={p.gsis_id} className="flex items-baseline gap-2 text-xs">
                        <span className="w-4 shrink-0 text-slate-400">{p.rank ?? '·'}</span>
                        <span className="flex-1 text-slate-800">{p.name}</span>
                        <span className="shrink-0 tabular-nums text-slate-500" title={cell.title}>{cell.text}</span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
