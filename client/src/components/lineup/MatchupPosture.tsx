import { PageLoading, PageError, logServerDetail } from '../PageState';

/**
 * "This matchup" — win probability against this week's actual opponent, and
 * whether that should change the lineup at all.
 *
 * Reads GET /api/trades/:leagueId/posture (server/services/lineup-posture.js).
 * Every number and every threshold comes from that response: the posture model
 * is being recalibrated, so nothing here restates its constants. The one rule
 * the page leans on is the server's own — posture advice exists only when the
 * matchup is lopsided — and in a close week the card says so plainly instead of
 * inventing a reason to fiddle with the lineup.
 */

export interface PostureSwap {
  slot: string;
  start: string; start_position?: string; start_ppg?: number;
  instead_of: string; instead_of_ppg?: number;
  points_given_up: number;
  lineup_sd_change?: number;
  win_prob_change: number;
  new_win_prob: number;
}

export interface Posture {
  error?: string;
  season?: number; week?: number;
  opponent_roster_id?: string | null;
  my_projection?: number; opponent_projection?: number | null;
  edge?: number;
  win_probability?: number;
  stance?: string;
  swaps?: PostureSwap[];
  note?: string;
  win_probability_scope?: string;
  /** What "You" and "Them" are summed from: the Start/Sit week points, betting line included. */
  projection_basis?: string;
}

const STANCE: Record<string, { label: string; chip: string; bar: string }> = {
  // 'neutral' means "under the server's MATERIAL_EDGE", not "close": since the
  // 2026-09-18 recalibration that is 23 points, so a 35% underdog is 'neutral'.
  neutral: { label: 'Neutral: play your best lineup', chip: 'bg-slate-100 text-slate-700 ring-slate-200', bar: 'bg-slate-400' },
  'chase variance': { label: 'Underdog: chase upside', chip: 'bg-amber-50 text-amber-900 ring-amber-200', bar: 'bg-amber-400' },
  'protect the lead': { label: 'Favourite: protect the floor', chip: 'bg-sky-50 text-sky-800 ring-sky-200', bar: 'bg-sky-500' }
};

const pts = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

export default function MatchupPosture({ data, loading, error, onRetry, opponentName }: {
  data: Posture | null; loading: boolean; error: string | null; onRetry: () => void;
  opponentName?: string | null;
}) {
  return (
    <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '60ms' }}
      aria-labelledby="matchup-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="matchup-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">This matchup</h2>
        {data && !data.error && data.opponent_roster_id && (
          <span className="min-w-0 truncate text-xs text-slate-500">
            {data.week ? `Week ${data.week} · ` : ''}vs <b className="text-slate-800">{opponentName || 'your opponent'}</b>
          </span>
        )}
      </div>
      <Body data={data} loading={loading} error={error} onRetry={onRetry} />
    </section>
  );
}

function Body({ data, loading, error, onRetry }: {
  data: Posture | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  if (loading && !data) return <PageLoading label="Sizing up this week's opponent…" />;
  if (error && !data) return <div className="mt-3"><PageError message={error} onRetry={onRetry} /></div>;
  if (!data) return null;
  if (data.error) {
    // UX-08: the server's reason can carry internal detail; logged, not rendered.
    logServerDetail('MatchupPosture', data.error);
    return <p className="mt-2 text-sm leading-6 text-slate-600">No matchup read for this league right now. Try again in a moment.</p>;
  }
  // No opponent on the synced schedule (bye week, or schedule not synced): the
  // server still answers, with a note and no probability. Show the note alone.
  if (data.win_probability == null) {
    return data.note ? <p className="mt-2 text-sm leading-6 text-slate-600">{data.note}</p> : null;
  }

  const stance = STANCE[data.stance ?? ''] ?? { label: data.stance ?? '—', chip: 'bg-slate-100 text-slate-700 ring-slate-200', bar: 'bg-slate-400' };
  const neutral = data.stance === 'neutral';
  const swaps = data.swaps ?? [];
  const wp = Math.max(0, Math.min(100, data.win_probability));
  const edge = data.edge ?? null;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
        <div>
          <div className="text-4xl font-black tabular-nums leading-none text-slate-950">{Math.round(wp)}%</div>
          <div className="mt-1 text-xs text-slate-500">chance to win</div>
        </div>
        <div className="min-w-0 flex-1">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${stance.chip}`}>
            {stance.label}
          </span>
          {/* Each figure wraps as a unit, so a narrow phone never strands "them"
              on its own line. */}
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm tabular-nums text-slate-600">
            <span className="whitespace-nowrap">You <b className="text-slate-950">{pts(data.my_projection)}</b></span>
            <span className="whitespace-nowrap">Them <b className="text-slate-950">{pts(data.opponent_projection)}</b></span>
            {edge != null && (
              <span className={`whitespace-nowrap font-mono text-xs ${edge > 0 ? 'text-good' : edge < 0 ? 'text-crit' : 'text-slate-500'}`}>
                {edge > 0 ? '+' : ''}{pts(edge)} pts
              </span>
            )}
          </div>
        </div>
      </div>

      {/* The probability as a bar from 0 to 100, with the even-money line marked,
          so "41%" reads as "a bit behind" rather than as a bare number. */}
      <div className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div className={`h-full rounded-full ${stance.bar}`} style={{ width: `${wp}%` }} />
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-400" />
      </div>

      {data.note && <p className="mt-3 text-sm leading-6 text-slate-700">{data.note}</p>}

      {neutral ? (
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Floor-or-ceiling advice only exists when the gap is wider than that, so there is none this week.
        </p>
      ) : swaps.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">
            Swaps that fit this matchup
          </div>
          {swaps.map((s, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 text-sm text-slate-800">
                  Start <b className="text-slate-950">{s.start}</b>
                  {s.start_position ? <span className="text-xs text-slate-400"> {s.start_position}</span> : null}
                  {' '}over <b className="text-slate-950">{s.instead_of}</b>
                  {' '}<span className="whitespace-nowrap text-xs text-slate-400">at {s.slot}</span>
                </span>
                <span className="shrink-0 font-mono text-sm font-black tabular-nums text-good">
                  {pts(wp)}% → {pts(s.new_win_prob)}%
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Gives up {pts(s.points_given_up, 2)} projected points to raise your win chance by{' '}
                {pts(s.win_prob_change)} percentage points.
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Every bench player was tried in every slot he can fill, and none moves your chances enough to be
          worth the points he costs — keep the highest-average lineup.
        </p>
      )}

      {data.win_probability_scope && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-4 text-slate-400">
          Win chance covers {data.win_probability_scope}.
          {data.projection_basis
            ? ' Both totals are the Start/Sit week points (this week\'s projection with the betting-line adjustment), so "You" matches the lineup below.'
            : ''}
        </p>
      )}
    </>
  );
}
