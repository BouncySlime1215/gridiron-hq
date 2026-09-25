import { useApi } from '../../api';

/**
 * TELLS-01b: the tells card. Per manager, the behavioural tells the clone
 * reads (reply latency, counter style, the price they have accepted, chat
 * wants), each with its n, its fitted weight and the E1 grade of the clone.
 *
 * Nothing is computed here: the server serves value, n, weight and direction.
 * A tell with no history renders "unknown" with the reason, never as 0; a thin
 * one is amber; chat wants is always "unproven" because the chat read is not
 * dated and so cannot be graded. Nothing is green until E1 passes.
 * Off unless the server says `enabled` (flag or local preview mode).
 */

type TellStatus = 'measured' | 'thin' | 'unknown' | 'unproven';

interface Tell {
  id: string;
  label: string;
  predicts: string;
  unit: string;
  graded: boolean;
  status: TellStatus;
  value: number | null;
  n: number;
  weight: number | null;
  direction: 'toward yes' | 'toward no' | 'none';
  reason: string | null;
  as_of: string;
  median_hours?: number | null;
  countered?: number;
  players?: string[];
}

interface E1Row {
  status: 'passing' | 'failing' | 'not_enough_data';
  metric: number | null;
  ci_low: number | null;
  ci_high: number | null;
  n: number;
  needs_text: string | null;
}

export interface TellsResponse {
  enabled: boolean;
  reason?: string;
  preview?: boolean;
  preview_reason?: string;
  card?: {
    league_id: number;
    as_of: string;
    fit_n: number;
    fit_reason: string | null;
    missing_sources: string[];
    managers: { team_id: string; tells: Tell[] }[];
  };
  grade?: { clone: E1Row; production: E1Row };
}

const STATUS_STYLE: Record<TellStatus, string> = {
  measured: 'text-slate-900',
  thin: 'text-amber-800',
  unknown: 'text-slate-400',
  unproven: 'text-amber-800'
};

function e1Line(row: E1Row | undefined) {
  if (!row) return 'E1: not graded';
  const gain = row.metric == null ? '—' : row.metric.toFixed(4);
  const ci = row.ci_low == null || row.ci_high == null ? '' : ` [${row.ci_low.toFixed(3)}, ${row.ci_high.toFixed(3)}]`;
  return `E1 ${row.status.replace(/_/g, ' ')}: log-loss gain vs activity-only ${gain}${ci}, n=${row.n}${row.needs_text ? ` — ${row.needs_text}` : ''}`;
}

function tellText(t: Tell) {
  if (t.status === 'unknown') return `unknown — ${t.reason ?? 'no history'}`;
  if (t.id === 'reply_latency' && t.median_hours != null) return `${t.median_hours} h median reply`;
  if (t.id === 'counter_style') return `${t.countered ?? 0} counters after ${t.n} no's`;
  if (t.id === 'chat_wants_player') return (t.players ?? []).join(', ') || 'none positive';
  return t.value == null ? '—' : t.value.toFixed(3);
}

export default function TellsCard({ leagueId, names }: { leagueId: number | string; names: Record<string, string> }) {
  const res = useApi<TellsResponse>(`/tells/${leagueId}/card`);
  if (res.loading && !res.data) return null;
  if (res.error) return <p className="text-[12px] text-rose-700">Tells card could not load: {res.error}</p>;
  const data = res.data;
  if (!data || !data.enabled || !data.card) return null;
  const { card, grade } = data;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-black uppercase tracking-[.16em] text-slate-500">Tells card</div>
      {data.preview && (
        <p className="mt-1 text-[12px] font-semibold text-amber-800">Preview (unconfirmed forward): {data.preview_reason}</p>
      )}
      <p className="mt-1 text-[12px] leading-5 text-slate-600">{e1Line(grade?.clone)}</p>
      <p className="text-[12px] leading-5 text-slate-500">
        Today's model, same offers: {e1Line(grade?.production)}. Weights fitted on {card.fit_n} resolved offers
        {card.fit_reason ? ` (${card.fit_reason})` : ''}. As of {card.as_of.slice(0, 16).replace('T', ' ')}.
      </p>
      {card.missing_sources.length > 0 && (
        <p className="text-[12px] text-amber-800">Not read: {card.missing_sources.join('; ')}</p>
      )}
      {card.managers.length === 0 && <p className="mt-2 text-sm text-slate-500">No resolved offers in this league yet.</p>}
      <div className="mt-3 space-y-3">
        {card.managers.map(m => (
          <div key={m.team_id} className="border-t border-slate-100 pt-2">
            <div className="text-sm font-bold text-slate-900">{names[m.team_id] ?? `Team ${m.team_id}`}</div>
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {m.tells.map(t => (
                <li key={t.id} className={`text-[12px] leading-5 ${STATUS_STYLE[t.status]}`} title={t.predicts}>
                  <span className="font-semibold">{t.label}</span>: {tellText(t)}
                  {t.status !== 'unknown' && <> · n={t.n}</>}
                  {t.status === 'thin' && <> · thin</>}
                  {t.status === 'unproven' && <> · unproven ({t.reason})</>}
                  {t.graded && t.weight != null && t.status !== 'unknown' && <> · weight {t.weight.toFixed(2)}, {t.direction}</>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
