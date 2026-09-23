import { PageLoading, PageError } from '../PageState';

/**
 * The defense streaming card (WV-01), on the page where the lineup is set.
 *
 * Reads GET /api/trades/:leagueId/streams (server/services/streaming-board.js#streamingBoard).
 * Free-agent defenses ranked by the betting market's implied points for the offense
 * they face (the last line before kickoff), the edge over the defense you hold, and
 * one suggestion that fits your roster. The history line quotes the replay in
 * docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md.
 */
export interface StreamRow {
  team: string; opponent: string | null; opp_implied: number | null;
  edge?: number | null; locked?: boolean; on_bye?: boolean; rank?: number | null;
}
export interface StreamBoard {
  error?: string; note?: string;
  season?: number; week?: number; position?: string;
  candidates?: StreamRow[]; my_defenses?: StreamRow[];
  suggestion?: { action: 'swap' | 'add' | 'hold' | null; why: string | null;
    add?: StreamRow | null; drop?: StreamRow | null; edge?: number | null };
  espn_add_url?: string | null;
  min_edge?: number;
  unconfirmed_forward?: boolean;
}

const SHOWN = 5;
const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

export default function StreamingBoard({ data, loading, error, onRetry }: {
  data: StreamBoard | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  return (
    <section id="defense-streams" className="tr-rise scroll-mt-16 rounded-2xl border border-slate-200 bg-white p-4"
      style={{ animationDelay: '220ms' }} aria-labelledby="streams-heading">
      <h2 id="streams-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">Stream a defense</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Free-agent defenses ranked by how many points the betting market expects the offense they face to score.
        {data?.unconfirmed_forward ? (
          <> Replayed on 2022-2025, swapping to the top-ranked free agent each week scored about 2.9 more points
            than the defense it replaced (range 0.9 to 4.8) — <strong>unconfirmed forward</strong>: not yet checked
            on 2026 games.</>
        ) : null}
      </p>
      <Body data={data} loading={loading} error={error} onRetry={onRetry} />
    </section>
  );
}

function Body({ data, loading, error, onRetry }: {
  data: StreamBoard | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  if (loading && !data) return <PageLoading label="Ranking defenses by matchup…" />;
  if (error && !data) return <div className="mt-3"><PageError message={error} onRetry={onRetry} /></div>;
  if (!data) return null;
  if (data.error) return <p className="mt-2 text-sm leading-6 text-slate-600">No streaming board right now: {data.error}.</p>;
  const rows = (data.candidates ?? []).slice(0, SHOWN);
  if (!rows.length) return <p className="mt-2 text-sm leading-6 text-slate-600">{data.note ?? 'No free-agent defense to rank this week.'}</p>;
  const s = data.suggestion;
  const mine = data.my_defenses ?? [];

  return (
    <>
      {s?.why && (
        <div className="mt-3 rounded-xl bg-slate-50 p-3">
          <div className="text-[10px] font-black uppercase tracking-wide text-emerald-700">
            {s.action === 'swap' ? `Swap: add ${s.add?.team}, drop ${s.drop?.team}`
              : s.action === 'add' ? `Add ${s.add?.team}`
                : s.action === 'hold' ? 'Hold your defense' : 'No move'}
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-700">{s.why}</p>
          {(s.action === 'swap' || s.action === 'add') && data.espn_add_url && (
            <a href={data.espn_add_url} target="_blank" rel="noreferrer"
              className="mt-2 inline-block rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
              Open ESPN free agents
            </a>
          )}
        </div>
      )}
      {mine.length > 0 && (
        <p className="mt-3 text-xs leading-5 text-slate-500">
          Your defense: {mine.map(d => d.on_bye ? `${d.team} (bye)` : `${d.team} vs ${d.opponent}, implied ${fmt(d.opp_implied)}`).join('; ')}
        </p>
      )}
      <ol className="mt-2 divide-y divide-slate-100">
        {rows.map(r => (
          <li key={r.team} className="flex items-center justify-between py-1.5 text-sm">
            <span className="font-semibold text-slate-800">{r.team} <span className="font-normal text-slate-500">vs {r.opponent}</span></span>
            <span className="tabular-nums text-slate-600">
              implied {fmt(r.opp_implied)}
              {r.edge != null && <span className={r.edge > 0 ? 'ml-2 text-emerald-700' : 'ml-2 text-slate-400'}>
                {r.edge > 0 ? `${fmt(r.edge)} easier` : `${fmt(-r.edge)} harder`}</span>}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
