import { useState } from 'react';

export interface Factor {
  key: string; label: string; unit: string;
  pick_value: number | null; opponent_value: number | null;
  pick_display: string; opponent_display: string;
  edge: number | null; strength: number; favors_pick: boolean;
}
export interface Sentiment {
  availability: string; note: string; books_quoted: number | null;
  opened?: number; current?: number; movement?: number;
  direction?: string; interpretation?: string;
}
export interface Reasoning {
  headline: string;
  model_probability: number | null; implied_probability: number | null; edge: number | null;
  projection_note: string | null; factors_considered: number;
  supporting: Factor[]; opposing: Factor[];
  supporting_text: string[]; opposing_text: string[];
  market_sentiment: Sentiment | null;
  market_agreement: string | null;
  confidence: string;
  no_history?: boolean;
  no_history_note?: string | null;
  news_context?: { pick_team: TeamNews; opponent: TeamNews } | null;
  news_policy?: string;
}
interface NewsClaim { player_name: string; signal_type: string; status: string; confidence: number; evidence_span: string; source?: string; }
interface TeamNews { team: string; claims: NewsClaim[]; unavailable_burden: number; role_pressure: number; production_eligible: boolean; }

const CONF_STYLE: Record<string, string> = {
  strong: 'bg-slate-100 text-slate-900 border-slate-300',
  moderate: 'bg-blue-50 text-blue-800 border-blue-200',
  lean: 'bg-slate-100 text-slate-600 border-slate-300'
};
const confClass = (c: string) =>
  CONF_STYLE[c] ?? (c.startsWith('contested') ? 'bg-white text-slate-700 border-slate-300' : 'bg-slate-100 text-slate-600 border-slate-300');

/**
 * Why the model likes a pick.
 *
 * Supporting and opposing evidence get equal visual weight on purpose — a pick
 * whose case is thin should look thin. The bar next to each factor is how far
 * apart the two teams are on it in league-relative terms, which is what decided
 * the ordering.
 */
export default function PickReasoning({ reasoning, defaultOpen = false }: {
  reasoning: Reasoning | null | undefined; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!reasoning) return null;
  const r = reasoning;
  if (r.factors_considered === 0 && !r.market_sentiment?.movement && !r.news_context?.pick_team.claims.length && !r.news_context?.opponent.claims.length) return null;

  return (
    <div className="border-t border-slate-100 mt-2 pt-2">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 w-full text-left">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span>Why this pick</span>
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full border ${confClass(r.confidence)}`}>
          {r.confidence}
        </span>
        <span className="text-xs text-slate-400 font-normal ml-auto">
          {r.factors_considered} factors compared
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-sm text-slate-700 leading-relaxed">{r.headline}</p>

          {r.no_history && r.no_history_note && (
            <p className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-600">
              {r.no_history_note}
            </p>
          )}

          {r.supporting.length > 0 && (
            <FactorList title="Supporting" tone="good" factors={r.supporting} />
          )}
          {r.opposing.length > 0 && (
            <FactorList title="Against this pick" tone="bad" factors={r.opposing} />
          )}
          {r.opposing.length === 0 && r.supporting.length > 0 && (
            <p className="text-[10px] text-slate-400">
              No compared factor favoured the other side.
            </p>
          )}

          {r.market_sentiment && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                Market movement
              </div>
              {r.market_sentiment.movement != null ? (
                <div className="text-[11px] text-slate-700">
                  <span className="font-semibold tabular-nums">
                    {r.market_sentiment.opened} → {r.market_sentiment.current}
                  </span>
                  <span className="text-slate-400"> ({r.market_sentiment.direction})</span>
                  <div className="text-slate-600 mt-0.5">{r.market_sentiment.interpretation}</div>
                </div>
              ) : (
                <div className="text-[11px] text-slate-500">No opening line stored for this game yet.</div>
              )}
              {r.market_agreement && (
                <div className={`text-[10px] mt-1.5 rounded px-2 py-1 ${
                  /moved in the same direction/.test(r.market_agreement)
                    ? 'bg-slate-100 text-slate-800' : 'bg-white text-slate-600'
                }`}>
                  {r.market_agreement}
                </div>
              )}
              <div className="text-[9px] text-slate-400 mt-1.5">{r.market_sentiment.note}</div>
            </div>
          )}
          {r.news_context && (r.news_context.pick_team.claims.length > 0 || r.news_context.opponent.claims.length > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Injuries & role news</div>
              {[r.news_context.pick_team, r.news_context.opponent].map(team => team.claims.length > 0 && <div key={team.team} className="mt-1.5"><div className="text-[10px] font-black text-slate-700">{team.team}</div>{team.claims.slice(0, 4).map((claim, index) => <div key={`${claim.player_name}-${claim.signal_type}-${index}`} className="text-[11px] leading-5 text-slate-700"><b>{claim.player_name}</b> · {claim.status.replaceAll('_', ' ')} · {Math.round(claim.confidence * 100)}% extraction confidence</div>)}</div>)}
              <div className="mt-2 text-[9px] leading-4 text-slate-500">{r.news_policy}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FactorList({ title, tone, factors }: { title: string; tone: 'good' | 'bad'; factors: Factor[] }) {
  const max = Math.max(...factors.map(f => f.strength), 1);
  return (
    <div>
      <div className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${
        tone === 'good' ? 'text-slate-900' : 'text-rose-600'}`}>{title}</div>
      <div className="space-y-1">
        {factors.map(f => (
          <div key={f.key} className="flex items-center gap-2">
            <div className="w-12 h-1.5 bg-slate-100 rounded overflow-hidden shrink-0">
              <div className={`h-full rounded ${tone === 'good' ? 'bg-sky-500' : 'bg-rose-400'}`}
                style={{ width: `${Math.max(6, (f.strength / max) * 100)}%` }} />
            </div>
            <div className="text-[11px] text-slate-600 min-w-0 flex-1">
              <span className="font-semibold text-slate-800">{cap(f.label)}</span>
              <span className="text-slate-400"> · </span>
              <span className="tabular-nums">{f.pick_display}</span>
              <span className="text-slate-400"> vs {f.opponent_display}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
