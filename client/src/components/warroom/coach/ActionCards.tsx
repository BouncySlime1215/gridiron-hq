import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Icon from '../icons';
import { CopyButton } from '../cardParts';
import type { CoachProposal, WarRoomCoach } from './useWarRoomCoach';
import type { CoachAction, Pending } from './warroomCoach';

/**
 * COACH-CHAT action cards: what Coach proposes, drawn inside the conversation.
 * Each card says what it is, what changes, which of Nick's rules it touches
 * (never loosening one) and waits for a tap: [Do it] records it, [Not now]
 * drops it. Nothing runs on its own, and Coach never sends an offer: a draft
 * is copied by Nick and sent by Nick.
 */

/*
 * The design system's Card and Button, by their classes (ui/DesignSystem.tsx renders exactly
 * these): the War Room folder is compiled on its own for its render tests, so it does not
 * import from outside itself.
 */
function Card({ tone, children }: { tone: 'good' | 'bad' | 'accent'; children: ReactNode }) {
  return <div className={`ds-card ds-card-${tone} wr-action`}>{children}</div>;
}
function Button({ variant = 'default', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'quiet' }) {
  return <button type="button" {...rest} className={`ds-btn ds-btn-sm${variant === 'primary' ? ' ds-btn-primary' : variant === 'quiet' ? ' ds-btn-quiet' : ''}`}>{children}</button>;
}

/** The same rule line on every card: the plan can change, Nick's trade rules do not. */
export const RULES_LINE = 'Your trade rules stay on: never overpay, blue chips protected.';

const GOAL_WORDS: Record<string, string> = { title: 'Win the title', playoffs: 'Make the playoffs', get_player: 'Get one player', points: 'Score more points each week' };
const MODE_WORDS: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: 'All in' };
const TOLERANCE_WORDS: Record<string, string> = {
  max_assets: 'Most players to give in one move', max_offers_per_manager_week: 'Offers per manager each week',
  max_downside_per_step: 'Most title odds to risk per step', reputation_budget: 'How hard to push league-mates', ai_spend: 'AI use'
};

/** A plan change in words: the card's title. */
export function planChangeTitle(a: CoachAction): string {
  switch (a.type) {
    case 'set_objective': return `Change goal to: ${GOAL_WORDS[a.goal] ?? a.goal}`;
    case 'set_risk_mode': return `Switch the plan to: ${MODE_WORDS[a.mode] ?? a.mode}${a.until_week ? ` until week ${a.until_week}` : ''}`;
    case 'set_tolerance': return `Set "${TOLERANCE_WORDS[a.key] ?? a.key}" to ${a.value}`;
    case 'add_stop': return `Add a stop: ${a.stop.label}`;
    case 'remove_stop': return 'Remove a stop from the route';
    default: return 'Change the plan';
  }
}

const signed = (v: unknown) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pts` : null);

type Status = 'idle' | 'working' | 'done' | 'failed' | 'dismissed';

function Shell({ title, children, status, error }: { title: string; children: ReactNode; status: Status; error?: string | null }) {
  return (
    <Card tone={status === 'done' ? 'good' : status === 'failed' ? 'bad' : 'accent'}>
      <div className="wr-action-b" data-testid="coach-action-card">
        <div className="wr-action-t"><Icon name={status === 'done' ? 'check' : 'sliders'} size={16} /><span>{title}</span></div>
        {children}
        {status === 'failed' && error && <p className="wr-action-err" role="alert">{error}</p>}
      </div>
    </Card>
  );
}

/** A plan change Coach proposed (the pending trade-off preview), with Do it / Not now. */
export function PlanChangeCard({ pending, coach, onChanged }: { pending: Pending; coach: WarRoomCoach; onChanged?: () => void }) {
  const [status, setStatus] = useState<Status>('idle');
  const v = pending.preview.status === 'ok' ? pending.preview.value : null;
  const title = planChangeTitle(pending.action);
  const doIt = async () => {
    setStatus('working');
    await coach.confirm();
    setStatus('done');
    onChanged?.();
  };
  return (
    <Shell title={title} status={status}>
      <ul className="wr-action-l">
        {v ? <>
          {signed(v.net) && <li><span>What changes</span> title odds {signed(v.net)} overall{v.verdict ? `, ${String(v.verdict).replace(/_/g, ' ')}` : ''}</li>}
          {v.new_next_move_changes != null && <li><span>Next move</span> {v.new_next_move_changes ? 'changes after this' : 'stays the same'}</li>}
          {v.because && <li><span>Because</span> {v.because}</li>}
        </> : <li><span>What changes</span> {pending.preview.reason ?? 'The trade-off has not been worked out yet; the plan re-runs after you confirm.'}</li>}
        <li><span>Your rules</span> {RULES_LINE}</li>
      </ul>
      {status === 'done' ? <p className="wr-action-ok">Done. The plan re-runs with this change.</p> : (
        <div className="wr-action-btns">
          <Button variant="primary" disabled={status === 'working'} onClick={() => { void doIt(); }}>Do it</Button>
          <Button variant="quiet" disabled={status === 'working'} onClick={coach.cancel}>Not now</Button>
        </div>
      )}
    </Shell>
  );
}

/** "I sent it" / "Skip this card": War Room records Nick confirms with a tap. */
export function ProposalCard({ proposal, coach, onChanged }: { proposal: CoachProposal; coach: WarRoomCoach; onChanged?: () => void }) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  if (status === 'dismissed') return null;
  const doIt = async () => {
    setStatus('working');
    try {
      await coach.doProposal(proposal);
      setStatus('done');
      onChanged?.();
    } catch (e) {
      setError(`Not recorded: ${e instanceof Error ? e.message : String(e)}`);
      setStatus('failed');
    }
  };
  const sent = proposal.kind === 'offer.sent';
  return (
    <Shell title={proposal.title} status={status} error={error}>
      <ul className="wr-action-l">
        <li><span>What changes</span> {proposal.changes}</li>
        <li><span>Your rules</span> {proposal.rules}</li>
      </ul>
      {status === 'done' ? <p className="wr-action-ok">{sent ? 'Logged as sent. Tell Coach when he replies.' : 'Skipped. The next card is up.'}</p> : (
        <div className="wr-action-btns">
          {sent && proposal.message && <CopyButton text={proposal.message} label="Copy message" />}
          <Button variant={sent ? 'default' : 'primary'} disabled={status === 'working'} onClick={() => { void doIt(); }}>
            {sent ? 'I sent it' : 'Do it'}
          </Button>
          <Button variant="quiet" disabled={status === 'working'} onClick={() => setStatus('dismissed')}>Not now</Button>
          {!sent && <a className="wr-link" href="/trades?view=build">Open Build</a>}
        </div>
      )}
    </Shell>
  );
}

/** A message Coach drafted: Nick copies it and sends it himself. */
export function DraftCard({ text }: { text: string }) {
  return (
    <Shell title="Draft message" status="idle">
      <p className="wr-action-draft">{text}</p>
      <ul className="wr-action-l"><li><span>Your rules</span> Coach never sends it. Copy it and send it yourself.</li></ul>
      <div className="wr-action-btns"><CopyButton text={text} label="Copy message" /></div>
    </Shell>
  );
}
