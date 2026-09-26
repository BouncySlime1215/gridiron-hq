import { useState } from 'react';
import { api } from '../../api';
import { PageError } from '../PageState';
import CopyLine from './CopyLine';
import { asText } from './types';
import type { Proposal, ProposalsResponse, RejectedProposal } from './types';
import RulesHidden from '../trade/RulesHidden';
import { BudgetLink } from '../settings/spendLinks';

/**
 * The AI-written slate: proposals in a form that can be pasted into a group chat.
 *
 * Two rules shape this component.
 *
 * 1. **It never fires on mount.** `GET /trades/:id/proposals` runs the trade
 *    finder and then pays for a Sonnet call against a $0.50/day budget shared
 *    across every league (see the note on `liveCaller` in
 *    server/services/trade-proposals.js). A page that spends money by being
 *    opened is a bug, so this is a button with the cost written on it, in the
 *    same on-demand idiom as the AI buttons on a TradeCard.
 *
 * 2. **"No proposals" is three different answers and they are rendered as
 *    three.** `refused` with `source: 'none'` means we could not ask — no key,
 *    the budget is gone, or the slate could not be traced. `refused` with
 *    `source: 'model'` means the model answered and every proposal was thrown
 *    out by the verifier for naming a player or a number the ideas do not
 *    contain. Neither is "nothing to propose", which is the third answer and
 *    the only one that is about the league rather than about us.
 */

/** The one-line note beside the button (Nick's cleanup: no model or dollar figures in the main view). */
const COST_NOTE_SHORT = 'Uses the AI budget; written only when you press it, and checked against the ideas before it is shown.';

/** The full note, shown in Settings → AI & developer. */
export const COST_NOTE = 'This runs the trade finder, then pays for one Sonnet call against a $0.50/day '
  + 'budget shared across all your leagues. An unchanged slate is served from cache and costs nothing.';

function SourceBadge({ source }: { source: ProposalsResponse['source'] }) {
  if (source === 'cache') {
    return (
      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 ring-1 ring-slate-200"
        title="The slate had not changed, so the stored answer was reused. No money was spent.">
        Served from cache · free
      </span>
    );
  }
  if (source === 'model') {
    return (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200"
        title="A fresh model call was made and charged against the trade-proposals budget.">
        Fresh model call · spent from the budget
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 ring-1 ring-slate-200">
      No model call was made
    </span>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{hint}</div>}
    </div>
  );
}

function Names({ label, names, tone }: { label: string; names: string[]; tone: 'give' | 'get' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {names.length ? names.map((n, i) => (
          <span key={`${n}:${i}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${
            tone === 'get' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
            {n}
          </span>
        )) : <span className="text-xs text-slate-500">Not named</span>}
      </div>
    </div>
  );
}

function ProposalCard({ proposal, index }: { proposal: Proposal; index: number }) {
  const timing = proposal.timing;
  const send = typeof timing === 'object' && timing ? timing.send ?? null : null;
  const timingReason = typeof timing === 'object' && timing ? timing.reason ?? null : asText(timing);
  const opener = String(proposal.opener ?? '');
  const ask = asText(proposal.ask);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">
          Proposal {index + 1}
        </span>
        {send && (
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${
            send === 'now' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : 'bg-amber-50 text-amber-900 ring-amber-200'}`}>
            {send === 'now' ? 'Send now' : `Wait — ${send}`}
          </span>
        )}
      </div>

      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Names label="You give" names={proposal.package?.i_give ?? []} tone="give" />
        <Names label="You get" names={proposal.package?.i_get ?? []} tone="get" />
      </div>

      {proposal.why_they_say_yes && (
        <p className="mt-3 text-sm leading-6 text-slate-700">
          <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">Why they say yes </span>
          {proposal.why_they_say_yes}
        </p>
      )}

      {/* The deliverable: text that goes into a league chat, one click away. */}
      <div className="mt-3 space-y-2">
        {opener && <CopyLine tone="accent" label="Opening message" text={opener}
          hint="Paste this straight into the league chat." />}
        {ask !== '—' && <CopyLine label="What to ask for" text={ask}
          hint="Your opening ask — not the most you should give up." />}
        {opener && ask !== '—' && (
          <CopyLine label="Opener and ask together" text={`${opener}\n\nAsk: ${ask}`} />
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Fact label="Ask" value={ask} hint="Open here" />
        <Fact label="Fair" value={asText(proposal.fair)} hint="Even on both sides" />
        <Fact label="Floor" value={asText(proposal.floor)} hint="The most to give up" />
      </div>

      {timingReason && timingReason !== '—' && (
        <p className="mt-2 text-[12px] leading-5 text-slate-600">
          <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">Timing </span>
          {timingReason}
        </p>
      )}
      {proposal.risk && (
        <p className="mt-1 text-[12px] leading-5 text-slate-600">
          <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">Risk </span>
          {proposal.risk}
        </p>
      )}

      <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-5 text-slate-500">
        Verified against idea{(proposal.idea_ids ?? []).length === 1 ? '' : 's'}{' '}
        {(proposal.idea_ids ?? []).map(String).join(', ') || '—'}. Leaned on: {asText(proposal.data_used)}.
      </p>
    </article>
  );
}

function RejectedList({ rejected }: { rejected: RejectedProposal[] }) {
  const [open, setOpen] = useState(false);
  if (!rejected.length) return null;
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <button type="button" className="text-sm font-bold text-slate-800" onClick={() => setOpen(v => !v)}
        aria-expanded={open}>
        {open ? '▾' : '▸'} {rejected.length} proposal{rejected.length === 1 ? '' : 's'} thrown out by the verifier
      </button>
      <p className="mt-1 text-[12px] leading-5 text-slate-600">
        A proposal that names a player or a number the ideas it cites do not contain is rejected
        whole, never patched. What the model actually wrote is kept so it can be read.
      </p>
      {open && (
        <ul className="mt-2 space-y-2">
          {rejected.map((r, i) => (
            <li key={i} className="rounded-xl border border-slate-200 bg-white p-3">
              <ul className="space-y-0.5">
                {(r.violations ?? []).map((v, j) => (
                  <li key={j} className="text-[12px] leading-5 text-rose-700">⚠ {v}</li>
                ))}
              </ul>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-500">
                {typeof r.proposal === 'string' ? r.proposal : JSON.stringify(r.proposal, null, 2)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One of the three ways a slate can come back with nothing in it. */
function NoProposals({ result }: { result: ProposalsResponse }) {
  const refused = result.refused === true;
  const askedTheModel = result.source === 'model';

  const title = !refused ? 'Nothing to propose in this league right now'
    : askedTheModel ? 'The model answered and nothing survived verification'
      : 'We could not ask the model';

  const body = !refused
    ? 'No trade idea passed the edge test, so there was nothing to write up. This is about the '
      + 'league, not about us: the finder ran and came back empty.'
    : askedTheModel
      ? 'Every proposal named a player or a number that is in none of the ideas it cited, so all of '
        + 'them were rejected whole rather than patched. Nothing here is safe to send.'
      : 'No model call happened, so this is not "no good trades" — we never got to ask. Usually the '
        + 'daily budget is spent or no API key is configured.';

  return (
    <section role="status" className={`rounded-2xl border p-4 ${refused
      ? 'border-amber-300 bg-amber-50/70' : 'border-slate-300 bg-slate-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={`text-sm font-black uppercase tracking-wide ${refused ? 'text-amber-900' : 'text-slate-700'}`}>
          {title}
        </h2>
        <SourceBadge source={result.source} />
      </div>
      <p className={`mt-1.5 text-sm leading-6 ${refused ? 'text-amber-900' : 'text-slate-700'}`}>{body}</p>
      {result.reason && (
        <p className="mt-1 text-[12px] leading-5 text-slate-600">
          <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">Reason </span>
          {result.reason}
        </p>
      )}
      {result.budget_key && (
        <p className="mt-1 text-sm" data-testid="proposal-budget-link"><BudgetLink budgetKey={result.budget_key}>Change the trade proposals budget</BudgetLink></p>
      )}
      {refused && !askedTheModel && (
        <p className="mt-1 text-xs leading-5 text-slate-500">
          A refusal is never cached, so trying again tomorrow (or after setting a key in Settings) costs
          nothing extra.
        </p>
      )}
      <div className="mt-3"><RejectedList rejected={result.rejected ?? []} /></div>
    </section>
  );
}

export default function ProposalSlate({ leagueId }: { leagueId: number }) {
  const [result, setResult] = useState<ProposalsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deliberately `api()` and not `useApi()`: a hook that fetches on mount would
  // spend money every time this tab is opened.
  const write = async () => {
    setBusy(true); setError(null);
    try {
      setResult(await api<ProposalsResponse>(`/trades/${leagueId}/proposals`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The proposals request failed.');
    } finally { setBusy(false); }
  };

  const proposals = result?.proposals ?? [];

  return (
    <div className="space-y-4">
      {/* One button with a one-line cost note; the full cost and model detail is in Settings → AI & developer. */}
      <section className="flex flex-wrap items-center gap-3" data-testid="write-proposals">
        <button type="button" className="ds-btn ds-btn-quiet" onClick={write} disabled={busy}
          title={busy ? 'Writing the proposals' : 'Write sendable openers for the best ideas (uses the AI budget)'}>
          {busy ? 'Writing…' : result ? 'Write them again' : 'Write proposals'}
        </button>
        <span className="ds-note">{COST_NOTE_SHORT}</span>
        {result && <SourceBadge source={result.source} />}
      </section>

      {error && <PageError message={error} onRetry={write} />}

      <RulesHidden n={result?.dropped_by_rule} />

      {result && !proposals.length && <NoProposals result={result} />}

      {!!proposals.length && (
        <>
          {result?.reason && (
            <p className="text-[12px] leading-5 text-slate-600">
              <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">Note </span>
              {result.reason}
            </p>
          )}
          <div className="space-y-3">
            {proposals.map((p, i) => <ProposalCard key={i} proposal={p} index={i} />)}
          </div>
          <RejectedList rejected={result?.rejected ?? []} />
        </>
      )}

      {/* Before the button is pressed the button and its note say it all; nothing else is drawn. */}
    </div>
  );
}
