import { useState } from 'react';
import { Button, Card, Chip, Icon, type Tone } from '../ui/DesignSystem';

/**
 * COACH-CHAIN: a trade chain, like a GM plans it. Step 1 -> Step 2 -> Step 3, each with its lineup and
 * playoff-odds change, the hole the chain leaves and the moves that fill it, and the whole chain against
 * doing nothing. ONE component, prop-driven and self-contained, so it drops into any page unchanged:
 *   variant="full"     a page (the Coach page): steps side by side on a wide screen, stacked on a phone.
 *   variant="compact"  inside a Coach answer in the drawer: one column, the fills folded behind a toggle.
 * Everything shown arrives ready from the one producer (server services/coach/chain-view.js#chainView):
 * the labels, the formatted numbers, the rule notes. Nothing is computed here. "Send" is on step 1 only;
 * it copies the offer for Nick to send himself (Coach never sends), and is off when the step needs his
 * OK or breaks a rule.
 */
export interface ChainChip { label: string; text: string; tone: 'good' | 'bad' | 'neutral' }
export interface ChainHole { title: string; detail: string }
export interface ChainStep {
  index: number; source: 'you' | 'suggested'; title: string; partner: string; chips: ChainChip[]; after: string;
  needs_ok: boolean; blocked?: string | null; note?: string | null; chance?: string | null; hole?: ChainHole | null;
  send?: { enabled: boolean; text: string } | null;
}
export interface ChainFill { title: string; partner: string; chips: ChainChip[]; chance: string | null; needs_ok: boolean; kind: string }
export interface ChainTotals { title: string; chips: ChainChip[]; detail: string; needs_ok: boolean }
/** LOOKAHEAD: one first move, ranked by what it sets up (its expected value with the best follow-ups). */
export interface ChainRanked { rank: number; title: string; partner: string; chips: ChainChip[]; yours: boolean; needs_ok: boolean; chance: string | null; then: string[] }
export interface ChainData {
  steps: ChainStep[]; hole: ChainHole | null; fills: ChainFill[]; totals: ChainTotals | null; fills_note?: string | null;
  /** LOOKAHEAD: the first moves by what they set up, and the baseline (doing nothing now, then the best moves). */
  ranked?: ChainRanked[]; baseline?: string | null;
}

const TONE: Record<ChainChip['tone'], Tone> = { good: 'good', bad: 'bad', neutral: 'neutral' };

function Chips({ chips }: { chips: ChainChip[] }) {
  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {chips.map(c => <Chip key={c.label} tone={TONE[c.tone]} title={c.label}>{c.label} {c.text}</Chip>)}
    </div>
  );
}

function SendButton({ step, onSend }: { step: ChainStep; onSend?: (step: ChainStep) => void }) {
  const [copied, setCopied] = useState(false);
  if (!step.send) return null;
  const off = !step.send.enabled;
  const send = async () => {
    if (onSend) { onSend(step); return; }
    try { await navigator.clipboard?.writeText(step.send!.text); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" icon={copied ? 'check' : 'copy'} disabled={off} onClick={send}
        title={off ? (step.needs_ok ? 'Needs your OK first' : 'Breaks one of your rules') : 'Copies the offer; you send it yourself'}>
        {copied ? 'Copied' : 'Send'}
      </Button>
      <span className="ds-note" data-testid="chain-send-note">
        {off ? (step.needs_ok ? 'Needs your OK before it can be sent.' : 'Not sendable: it breaks one of your rules.')
          : copied ? 'Copied. Send it in your league app yourself.' : 'Copies the offer. You send it yourself.'}
      </span>
    </div>
  );
}

function StepCard({ step, onSend, last }: { step: ChainStep; onSend?: (step: ChainStep) => void; last: boolean }) {
  return (
    <li className="relative min-w-0" data-testid={`chain-step-${step.index}`}>
      <div className="h-full min-w-0 rounded-[var(--r-tile)] bg-[var(--c-soft)] p-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">Step {step.index}</span>
          <Chip tone={step.source === 'you' ? 'accent' : 'neutral'}>{step.source === 'you' ? 'Your move' : 'Suggested'}</Chip>
          {step.needs_ok && <Chip tone="warn">Needs your OK</Chip>}
        </div>
        <p className="break-words text-sm font-semibold">{step.title}</p>
        {step.partner && <div className="ds-note break-words">{step.partner}</div>}
        <Chips chips={step.chips} />
        {step.after && <div className="ds-note mt-1">{step.after}</div>}
        {step.chance && <div className="ds-note">{step.chance}</div>}
        {step.note && <div className="ds-note">{step.note}</div>}
        {step.blocked && <p className="mt-1 text-sm text-[var(--c-red)]" data-testid="chain-blocked">{step.blocked}</p>}
        <SendButton step={step} onSend={onSend} />
      </div>
      {!last && <Icon name="down" size={16} className="mx-auto my-1 block text-[var(--c-subtle)] lg:hidden" />}
    </li>
  );
}

function Fills({ fills, note }: { fills: ChainFill[]; note?: string | null }) {
  if (!fills.length) return note ? <p className="ds-note mt-1" data-testid="chain-no-fill">{note}</p> : null;
  return (
    <ol className="mt-1.5 space-y-2" data-testid="chain-fills">
      {fills.map((f, i) => (
        <li key={`${f.title}:${i}`} className="min-w-0 rounded-[var(--r-tile)] border border-[var(--c-line)] p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">{i === 0 ? 'Best fill' : `Option ${i + 1}`}</span>
            <Chip>{f.kind}</Chip>
            {f.needs_ok && <Chip tone="warn">Needs your OK</Chip>}
          </div>
          <p className="mt-1 break-words text-sm">{f.title}</p>
          <div className="ds-note break-words">{f.partner}</div>
          <Chips chips={f.chips} />
          {f.chance && <div className="ds-note mt-1">{f.chance}</div>}
        </li>
      ))}
    </ol>
  );
}

function Ranked({ ranked, baseline }: { ranked: ChainRanked[]; baseline?: string | null }) {
  const [all, setAll] = useState(false);
  if (!ranked.length && !baseline) return null;
  const shown = all ? ranked : ranked.slice(0, 3);
  return (
    <div className="mt-3" data-testid="chain-ranked">
      <div className="text-xs font-semibold">Best first moves, by what they set up</div>
      <ol className="mt-1.5 space-y-2">
        {shown.map(r => (
          <li key={`${r.rank}:${r.title}`} className="min-w-0 rounded-[var(--r-tile)] border border-[var(--c-line)] p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">#{r.rank}</span>
              {r.yours && <Chip tone="accent">Your move</Chip>}
              {r.needs_ok && <Chip tone="warn">Needs your OK</Chip>}
            </div>
            <p className="mt-1 break-words text-sm">{r.title}</p>
            <div className="ds-note break-words">{r.partner}</div>
            <Chips chips={r.chips} />
            {r.chance && <div className="ds-note mt-1">{r.chance}</div>}
            {r.then.length > 0 && <div className="ds-note break-words">Then: {r.then.join('; then ')}</div>}
          </li>
        ))}
      </ol>
      {ranked.length > 3 && (
        <Button size="sm" variant="quiet" className="mt-1" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${ranked.length}`}</Button>
      )}
      {baseline && <p className="ds-note mt-1.5 break-words" data-testid="chain-baseline">{baseline}</p>}
    </div>
  );
}

export default function ChainView({ steps, hole, fills, totals, fills_note: fillsNote = null, ranked = [], baseline = null, variant = 'compact', onSend }: ChainData & {
  variant?: 'full' | 'compact'; onSend?: (step: ChainStep) => void;
}) {
  const [open, setOpen] = useState(variant === 'full');
  const full = variant === 'full';
  return (
    <Card pad={false} className={full ? 'min-w-0 p-4' : 'min-w-0 p-3'} as="section">
      <div data-testid={`chain-${variant}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Icon name="arrow" size={16} />
          <span className={full ? 'text-base font-semibold' : 'text-xs font-semibold'}>Chain</span>
          {totals?.needs_ok && <Chip tone="warn">Needs your OK</Chip>}
        </div>
        {steps.length > 0 && (
          <ol className={full ? 'grid gap-2 lg:grid-cols-3' : 'space-y-0'} data-testid="chain-steps">
            {steps.map((s, i) => <StepCard key={s.index} step={s} onSend={onSend} last={i === steps.length - 1} />)}
          </ol>
        )}
        {hole && (
          <div className="mt-3" data-testid="chain-hole">
            <div className="text-sm font-semibold">{hole.title}</div>
            <p className="ds-note break-words">{hole.detail}</p>
          </div>
        )}
        {(fills.length > 0 || fillsNote) && (full || open
          ? <div className="mt-2"><div className="text-xs font-semibold">What fills it</div><Fills fills={fills} note={fillsNote} /></div>
          : null)}
        {(full || open) && <Ranked ranked={ranked} baseline={baseline} />}
        {totals && (
          <div className="mt-3 border-t border-[var(--c-line)] pt-2" data-testid="chain-totals">
            <div className="text-xs font-semibold">{totals.title}</div>
            <Chips chips={totals.chips} />
            <p className="ds-note mt-1 break-words">{totals.detail}</p>
          </div>
        )}
        {!full && (fills.length > 0 || fillsNote || ranked.length > 0) && (
          <div className="mt-1 flex justify-end">
            <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(o => !o)}>
              {open ? 'Hide the options' : `What fills it and the best first moves${ranked.length ? ` (${ranked.length})` : ''}`}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
