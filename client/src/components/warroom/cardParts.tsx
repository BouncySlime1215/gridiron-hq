import { useState } from 'react';
import type { Move } from './types';
import { Val } from './FieldState';
import { isOk } from './format';
import Icon from './icons';

/**
 * Card parts shared by the classic NEXT MOVE card (NextMoveDeck.tsx) and the v2 hero
 * (HeroCard.tsx): the negotiation ladder, the copyable message, and its label.
 * Moved here unchanged from NextMoveDeck.tsx so both layouts draw the same markup.
 */
export type Step = Move['steps'][number];
const samePkg = (a: string[], b: string[]) => [...a].sort().join('|') === [...b].sort().join('|');
/** CARD-CLARITY: the step's opening ask, when it is a different package from the planned step. */
export const openingAsk = (s: Step) => (isOk(s.opening) && !samePkg(s.opening.value.give, s.give) ? s.opening.value : null);
/** The message is written from the opening ask; say so whenever that differs from the plan. */
export const messageLabel = (s: Step) => (openingAsk(s) ? 'Opening message (the opening ask, not the plan)' : 'Message');

/**
 * CARD-CLARITY: the negotiation ladder, from the contract fields the step already carries:
 * Open with (step.opening, only when it differs from the plan), Plan (the step's give/get),
 * Walk away at (walk_away.max_give). One package per labelled rung, never an unlabelled third.
 */
export function Ladder({ s, text }: { s: Step; text: (ids: string[]) => string }) {
  const open = openingAsk(s);
  return (
    <ol className="wr-ladder" aria-label="Negotiation ladder">
      {open && (
        <li data-rung="open"><span className="wr-k">Open with</span>
          <span>{text(open.give)} for {text(open.get)}<span className="wr-hint"> Coach&apos;s opening ask, lower than the plan</span></span></li>
      )}
      <li data-rung="plan"><span className="wr-k">Plan</span><span>{text(s.give)} for {text(s.get)}</span></li>
      <li data-rung="walk"><span className="wr-k">Walk away at</span>
        <span title={isOk(s.walk_away) ? s.walk_away.value.text : undefined}>
          <Val f={s.walk_away} fmt={v => `${text(v.max_give)} for ${text(s.get)}`} showReason /></span></li>
    </ol>
  );
}

/** The copyable message. The clipboard can be blocked over plain HTTP; then the text stays selectable. */
export function CopyBlock({ label, text, note }: { label: string; text: string; note?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch { setState('failed'); }
  };
  return (
    <div className="wr-msg">
      <div className="wr-row">
        <span className="wr-cap">{label}</span>
        <span className="wr-sp" />
        <button type="button" className="wr-btn wr-sm wr-primary" onClick={copy}>{state === 'copied' ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="wr-msg-text">{text}</p>
      {note && <div className="wr-hint">{note}</div>}
      <div className="wr-hint">Coach never sends offers. Sending stays your tap in ESPN.</div>
      {state === 'failed' && <div className="wr-hint wr-red" role="status">Copy was blocked here. The text above selects in one tap.</div>}
    </div>
  );
}

/** WAR-ROOM-UI v2: a lone Copy button for the hero's action row (same clipboard rules as CopyBlock). */
export function CopyButton({ text, label = 'Copy message', primary, onCopy }: {
  text: string; label?: string; primary?: boolean; onCopy?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    onCopy?.();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch (e) {
      console.warn('War Room: copy was blocked', e);
      setState('failed');
    }
  };
  return (
    <button type="button" className={`wr-btn wr-btn-lg${primary ? ' wr-primary' : ''}`} onClick={copy} title={state === 'failed' ? 'Copy was blocked here. Open the message below and select it.' : undefined}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={18} />{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy blocked' : label}
    </button>
  );
}
