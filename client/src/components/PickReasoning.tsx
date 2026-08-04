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
}

const CONF_STYLE: Record<string, string> = {
  strong: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  moderate: 'bg-sky-100 text-sky-700 border-sky-300',
  lean: 'bg-slate-100 text-slate-600 border-slate-300'
};
const confClass = (c: string) =>
  CONF_STYLE[c] ?? (c.startsWith('contested') ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-slate-100 text-slate-600 border-slate-300');

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

  return (
    <div className="border-t border-slate-100 mt-2 pt-2">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 hover:text-slate-900 w-full text-left">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span>Why this pick</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${confClass(r.confidence)}`}>
          {r.confidence}
        </span>
        <span className="text-[10px] text-slate-400 font-normal ml-auto">
          {r.factors_considered} factors compared
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-[11px] text-slate-700 leading-relaxed">{r.headline}</p>

          {r.no_history && r.no_history_note && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
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
                    ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'
                }`}>
                  {r.market_agreement}
                </div>
              )}
              <div className="text-[9px] text-slate-400 mt-1.5">{r.market_sentiment.note}</div>
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
        tone === 'good' ? 'text-emerald-600' : 'text-rose-600'}`}>{title}</div>
      <div className="space-y-1">
        {factors.map(f => (
          <div key={f.key} className="flex items-center gap-2">
            <div className="w-12 h-1.5 bg-slate-100 rounded overflow-hidden shrink-0">
              <div className={`h-full rounded ${tone === 'good' ? 'bg-emerald-500' : 'bg-rose-400'}`}
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
