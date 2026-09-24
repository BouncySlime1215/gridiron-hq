import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api';
import { useLeague } from '../state/league';
import { usePageExplain } from '../components/PageExplainContext';
import { PageLoading, PageError, EmptyState } from '../components/PageState';
import ManagerBoard from '../components/brain/ManagerBoard';
import ProposalSlate from '../components/brain/ProposalSlate';
import PulseTicker from '../components/brain/PulseTicker';
import type { ProfilesResponse, SignalsResponse } from '../components/brain/types';
import WarRoom from '../components/warroom/WarRoom';
import { useWarRoom } from '../components/warroom/useWarRoom';

/**
 * The Trade Brain's own surface: the people, not one deal.
 *
 * Everything the engine knew about a counterparty — the hand-set tradeability
 * tier, the measured manager signals, the archetype, and the AI-written
 * proposals — was computed and served and rendered nowhere at all (master plan,
 * FANTASY-ENGINE-MASTER-PLAN.md:150). This page is that surface.
 *
 * It is a route of its own rather than an eighth Trade Lab tab because Trade
 * Lab is organised around *a deal*: every tab there takes a roster and produces
 * packages. This page is organised around *a person* — who answers, what they
 * value, and the message you send them. A Trade Lab tab would also have made
 * the manager tiers reachable only after picking "which team is me", which has
 * nothing to do with reading a counterparty. Trade Lab links here instead.
 *
 * The honesty rule on this page is not decoration. Four of the five connected
 * leagues have no chat corpus, so for most of them most of the measured layer
 * is empty — and an empty panel that says nothing reads as "this manager is
 * average", which is a claim we have not earned. Every gap names itself, every
 * value carries its `n`, and a thin sample is visibly different from a measured
 * neutral.
 */

// WR-1: the War Room is the first tab, drawn only when the server says it is enabled
// (server/services/warroom-flag.js: its own switch, or preview mode). Off = this page exactly as before.
const TABS = [
  { id: 'war-room', label: 'War Room', hint: 'The next move toward your goal, one decision at a time' },
  { id: 'managers', label: 'Who trades with you', hint: 'Your read of each manager, beside the measured one' },
  { id: 'proposals', label: 'Sendable proposals', hint: 'AI-written openers, on request — this one costs money' }
] as const;
type Tab = typeof TABS[number]['id'];
const isTab = (v: string | null): v is Tab => TABS.some(t => t.id === v);

export default function TradeBrain() {
  const { leagues, activeId, active, setActiveId, loading: leaguesLoading, error: leaguesError, refetch: refetchLeagues } = useLeague();
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<Tab | null>(() => { const v = params.get('view'); return isTab(v) ? v : null; });
  const warRoom = useWarRoom(activeId);
  const warOn = warRoom.data?.enabled === true;
  // War Room is the default tab only when it is on; asking for it while it is off falls back.
  const tab: Tab = picked === 'war-room' ? (warOn || warRoom.loading || warRoom.error ? 'war-room' : 'managers')
    : (picked ?? (warOn ? 'war-room' : 'managers'));
  const setTab = (t: Tab) => {
    setPicked(t);
    setParams(p => { const n = new URLSearchParams(p); n.set('view', t); return n; }, { replace: true });
  };

  // Two independent requests, on purpose: the measured signal layer is new and
  // may not exist on this server at all, and the hand-set tiers are the half
  // that always works. Neither may hold the other hostage — the same reason
  // Start/Sit reads its waivers and posture separately.
  const signals = useApi<SignalsResponse>(activeId ? `/trades/${activeId}/managers/signals` : null);
  const profiles = useApi<ProfilesResponse>(activeId ? `/trades/${activeId}/brain/managers` : null);

  const signalsLive = !!signals.data && signals.data.available === true && !signals.data.error;
  const managersRead = signals.data?.managers ?? [];

  // Must run before any early return so hook order never changes between
  // renders, and so the floating assistant is told what is actually on screen
  // rather than falling back to a route-derived guess.
  usePageExplain('trade brain', tab, {
    tab,
    league: active?.name ?? null,
    managers_settable: (profiles.data?.managers ?? []).length,
    signals_available: signalsLive,
    signals_unavailable_because: signalsLive ? null
      : (signals.error ?? signals.data?.error ?? signals.data?.reason ?? 'not requested yet'),
    managers_with_chat_corpus: managersRead.filter(m => m.corpus).length,
    managers_read: managersRead.length,
    identity_warnings: (signals.data?.identity_warnings ?? []).length,
    // Proposals are never fetched on load, so there is nothing to report about
    // them here — saying "0 proposals" would be a claim we have not made.
    proposals: 'written on request only'
  });

  if (leaguesLoading && !leagues.length) {
    return <Shell><PageLoading label="Loading your leagues…" /></Shell>;
  }
  if (leaguesError && !leagues.length) {
    return <Shell><PageError message={leaguesError} onRetry={refetchLeagues} /></Shell>;
  }
  if (!leagues.length) {
    return (
      <Shell>
        <EmptyState
          title="Connect a league to read your leaguemates"
          description="The Trade Brain is about the people in your league — who answers, what they value, and what to send them. It needs a synced league before any of that exists."
          actionLabel="Connect a league" actionTo="/league?view=connections"
        />
      </Shell>
    );
  }

  if (tab === 'war-room' && warOn && activeId && warRoom.data) {
    return (
      <WarRoom view={warRoom.data} activeId={activeId} onLeague={setActiveId} onExit={setTab}
        leagues={leagues.map(l => ({ id: l.id, name: l.name }))} />
    );
  }

  return (
    <Shell>
      <header>
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">Trade Brain</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">Who trades, and what to send them</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          A trade that would add four points a week is worth nothing if the manager on the other end
          never answers. This is the counterparty half of the engine: your own read of each person,
          the signals we could actually measure about them, and the message you send. Every number
          here carries the sample size it rests on, and where there is nothing measured it says so
          instead of showing a neutral.
        </p>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">
          Building one specific deal lives in{' '}
          <Link className="font-semibold text-emerald-700" to="/trade-lab">Trade Lab</Link>.
        </p>
      </header>

      {!activeId && <PageLoading label="Choosing a league…" />}

      {activeId && (
        <>
          <PulseTicker leagueId={activeId} />
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200">
            {TABS.filter(t => t.id !== 'war-room' || warOn).map(t => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} title={t.hint}
                className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-bold transition-colors ${
                  tab === t.id ? 'border-emerald-500 text-emerald-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'managers' && (
            <ManagerBoard leagueId={activeId} profiles={profiles} signals={signals} />
          )}
          {tab === 'proposals' && <ProposalSlate leagueId={activeId} />}
          {tab === 'war-room' && warRoom.loading && !warRoom.data && <PageLoading label="Loading the War Room…" />}
          {tab === 'war-room' && warRoom.error && (
            <PageError message={`Could not load the War Room: ${warRoom.error}`} onRetry={warRoom.refetch} />
          )}
        </>
      )}
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) =>
  <div className="mx-auto max-w-[1100px] space-y-5">{children}</div>;
