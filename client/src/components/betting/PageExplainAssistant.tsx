import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, useApi } from '../../api';
import { NOT_PROVEN_MESSAGE } from '../../pages/betting/copy';
import type { PageExplainInfo } from './PageExplainContext';

/**
 * The floating "what am I looking at" assistant — mounted once in
 * BettingWorkspace, so it follows the user onto every page under that shell
 * (Command, all of /betting/nfl, all of /betting/mlb). It never places a
 * bet, sizes a stake, or overrides a gate/verdict: it only explains, using
 * this desk's own glossary (server-side, TERMINOLOGY.md) and whatever small
 * `visible_summary` the current page registered via usePageExplain().
 *
 * Caching mirrors NflMarketBoard.tsx's existing explain() pattern: keyed by
 * page, "loading" while in flight, cached once answered so tab-switching
 * doesn't re-fire the same call.
 */
interface AiPageExplanation {
  paragraph: string; limitations: string[];
  audit: { id: number; reasoning_hash: string; model: string; authority: string; sequence: string[] };
}
type Answer = AiPageExplanation | { error: string } | 'loading';
interface HubStatus { model: { sizing_allowed: boolean } }

const pageKey = (route: string, info: PageExplainInfo) => `${route}::${info.section ?? ''}::${info.subview ?? ''}`;

const routeLabel = (route: string) => {
  const parts = route.split('/').filter(Boolean);
  if (parts.length === 0) return 'Betting home';
  return parts.map(part => part.replace(/-/g, ' ')).join(' → ');
};

export function PageExplainAssistant({ info }: { info: PageExplainInfo }) {
  const location = useLocation();
  const route = location.pathname;
  const key = pageKey(route, info);
  const hub = useApi<HubStatus>('/betting/status');

  const [open, setOpen] = useState(false);
  const [defaultAnswers, setDefaultAnswers] = useState<Record<string, Answer>>({});
  const [followUps, setFollowUps] = useState<Record<string, { question: string; answer: Answer }[]>>({});
  const [question, setQuestion] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const ask = async (typedQuestion: string | null) => {
    const body = {
      route, section: info.section ?? null, subview: info.subview ?? null,
      visible_summary: info.summary ?? {}, question: typedQuestion
    };
    if (typedQuestion) {
      setFollowUps(current => ({ ...current, [key]: [...(current[key] ?? []), { question: typedQuestion, answer: 'loading' }] }));
    } else {
      setDefaultAnswers(current => ({ ...current, [key]: 'loading' }));
    }
    try {
      const result = await api<AiPageExplanation>('/betting/explain/page', { method: 'POST', body: JSON.stringify(body) });
      if (typedQuestion) {
        setFollowUps(current => ({
          ...current,
          [key]: (current[key] ?? []).map((turn, index) => index === (current[key]?.length ?? 1) - 1 ? { ...turn, answer: result } : turn)
        }));
      } else {
        setDefaultAnswers(current => ({ ...current, [key]: result }));
      }
    } catch (error: any) {
      const failure = { error: error.message } as const;
      if (typedQuestion) {
        setFollowUps(current => ({
          ...current,
          [key]: (current[key] ?? []).map((turn, index) => index === (current[key]?.length ?? 1) - 1 ? { ...turn, answer: failure } : turn)
        }));
      } else {
        setDefaultAnswers(current => ({ ...current, [key]: failure }));
      }
    }
  };

  // Auto-fire the default "what am I looking at" explanation the first time
  // this exact page is opened — never re-fires on a tab switch back to a
  // page already answered, since defaultAnswers is keyed and kept for the
  // life of the component (component lives at the shell, so this persists
  // across in-app navigation, only resetting on a full page reload).
  useEffect(() => {
    if (!open) return;
    if (defaultAnswers[key]) return;
    ask(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const submitQuestion = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setQuestion('');
    ask(trimmed);
  };

  const defaultAnswer = defaultAnswers[key];
  const turns = followUps[key] ?? [];

  return <>
    <button onClick={() => setOpen(current => !current)}
      aria-label={open ? 'Close page explainer' : 'What am I looking at?'}
      className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full border border-slate-800 bg-slate-950 text-white shadow-[0_12px_30px_rgba(15,23,42,.35)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(15,23,42,.4)]">
      {open
        ? <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        : <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>}
    </button>

    {open && <div ref={panelRef} role="dialog" aria-label="Page explainer"
      className="fixed bottom-24 right-5 z-40 flex max-h-[70vh] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,.25)]">
      <div className="border-b border-slate-100 bg-slate-950 px-4 py-3 text-white">
        <div className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-300">What am I looking at</div>
        <div className="mt-0.5 truncate text-sm font-bold">{routeLabel(route)}</div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <AnswerBlock answer={defaultAnswer} />
        {turns.map((turn, index) => <div key={index} className="space-y-1.5 border-t border-slate-100 pt-3">
          <div className="text-xs font-bold text-slate-500">You asked: {turn.question}</div>
          <AnswerBlock answer={turn.answer} />
        </div>)}
      </div>

      <div className="border-t border-slate-100 px-4 py-2.5">
        <p className="text-[10px] leading-4 text-slate-400">
          Explanation only — this assistant can never place a bet, size a stake, or change a pick or gate.
          {hub.data && !hub.data.model.sizing_allowed && <> {NOT_PROVEN_MESSAGE}</>}
        </p>
        <form onSubmit={submitQuestion} className="mt-2 flex items-center gap-2">
          <input value={question} onChange={event => setQuestion(event.target.value)}
            placeholder="Ask a follow-up…" aria-label="Ask a follow-up question"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none" />
          <button type="submit" disabled={!question.trim()}
            className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-black text-white disabled:opacity-40">Ask</button>
        </form>
      </div>
    </div>}
  </>;
}

function AnswerBlock({ answer }: { answer: Answer | undefined }) {
  if (!answer) return <p className="text-xs text-slate-400">Loading…</p>;
  if (answer === 'loading') return <p className="text-xs text-slate-400">Thinking…</p>;
  if ('error' in answer) return <p className="text-xs text-rose-700">{answer.error}</p>;
  return <div className="space-y-1.5">
    <p className="text-sm leading-5 text-slate-800">{answer.paragraph}</p>
    {answer.limitations.length > 0 && <ul className="space-y-0.5 text-[11px] leading-4 text-slate-400">
      {answer.limitations.map((note, index) => <li key={index}>· {note}</li>)}
    </ul>}
  </div>;
}
