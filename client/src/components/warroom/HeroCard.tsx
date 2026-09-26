import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Field, Move, ReplyKind, WarRoomView } from './types';
import { REASONING_SLOTS, namer, teamLabel } from './types';
import { Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import ReplyTable from './ReplyTable';
import { HisScreenToggle, hisScreenPath } from './HisScreen';
import { useHisScreen } from './useWarRoom';
import { CopyBlock, CopyButton, Ladder, messageLabel } from './cardParts';
import { heroStatus, isGuess, playerParts, valueEdgeText } from './heroStatus';
import { HeadshotContext } from './Avatar';
import TradeSides from './TradeSides';
import Icon from './icons';
import { useSpotlight } from './spotlight';
import CountUp from './CountUp';
import ChanceStat from './ChanceStat';

/**
 * WAR-ROOM-UI v2: the NEXT MOVE as one clean hero card. Only what decides the send is
 * on it: who, what Nick gives and gets (big player chips), the status badge with its
 * one-line reason (heroStatus.ts), three big numbers (chance he says yes, title odds
 * before -> after, value edge), one Copy-message button and "Ask Coach about this".
 * Everything else about the move (message text, walk-away, replies, reasoning) is
 * MoveDetails, drawn behind the page's one Details disclosure. NextMoveDeck owns the
 * deck state and every post; this file only draws and calls back.
 */
export default function HeroCard({ move, view, leagueId, chosen, isSent, thread, onPick, onMarkSent, onAskCoach, ajBanner = null }: {
  move: Move;
  view: WarRoomView;
  leagueId: number;
  /** This card was picked (Copy message or Do it) and no negotiation thread replaced it. */
  chosen: boolean;
  isSent: boolean;
  /** The live negotiation thread for this move, when negotiation mode opened one. */
  thread: ReactNode | null;
  onPick: () => void;
  onMarkSent: () => void;
  onAskCoach?: () => void;
  /** AJ-PICK: the "Needs your OK" banner; while it shows, the card cannot be copied or marked sent. */
  ajBanner?: ReactNode;
}) {
  const n = namer(view.names);
  const s = move.steps[0];
  const partner = teamLabel(s.partner);
  const clock = view.reply_clock?.[String(s.partner)] ?? null;
  const status = heroStatus(s);
  const titleNow = isOk(view.destination) ? view.destination.value.title_now : undefined;
  const noise = isOk(s.title_odds_delta) && s.title_odds_delta.clears_2se === false;
  const both = isOk(titleNow) && isOk(s.title_after);
  const spot = useSpotlight<HTMLElement>();
  // The one give/get block (TradeSides), with this page's headshots (ESPN only; initials otherwise).
  const shots = useContext(HeadshotContext);
  const toSide = (id: string) => { const p = playerParts(n.one(id).name); return { id, name: p.name, pos: p.pos, headshot: (shots?.[String(id)] ?? '').startsWith('https://a.espncdn.com/') ? shots![String(id)] : null, title: n.one(id).name }; };

  return (
    <article className="wr-hero-card" data-testid="hero-card" aria-label={ajBanner ? 'Needs your OK' : 'Next move'} {...spot.handlers} ref={spot.ref}>
      <span className="wr-spot" aria-hidden><span className="wr-spot-blob" /></span>
      {ajBanner}
      <div className="wr-hero-head">
        <div className="wr-hero-partner">
          <span className="wr-k">Send to</span>
          <h2 className="wr-hero-who">{partner}</h2>
          {clock && <p className="wr-sub" data-testid="hero-send-when" data-guess={clock.guess ? '1' : '0'}>{clock.text}</p>}
        </div>
        <span className={`wr-status wr-status-${status.tone}`} data-testid="hero-status" data-tone={status.tone}
          title={status.reasons.length ? `Why not yet: ${status.reasons.join('; ')}` : 'Nothing shown is a guess and the gain clears 2 SE.'}>
          <Icon name={status.tone === 'green' ? 'ok' : status.tone === 'red' ? 'stop' : 'warn'} size={16} />{status.label}
        </span>
      </div>

      <TradeSides give={s.give.map(toSide)} get={s.get.map(toSide)} />

      <div className="wr-hero-nums">
        <ChanceStat size="big" testid="hero-chance" value={isOk(s.p_yes) ? s.p_yes.value : null}
          big={<BigVal f={s.p_yes} fmt={v => pct(v)} />} guess={isGuess(s.p_yes)} />
        <Metric label="Title odds if he says yes" testid="hero-odds"
          big={both
            ? <><BigVal f={titleNow} fmt={v => pct(v, 1)} /><span className="wr-hero-to"> → </span><BigVal f={s.title_after} fmt={v => pct(v, 1)} /></>
            : <BigVal f={s.title_odds_delta} fmt={pts} />}
          sub={both ? <BigVal f={s.title_odds_delta} fmt={pts} /> : !isOk(titleNow) ? <span title={titleNow?.reason}>odds now: {NOT_COMPUTED}</span> : null}
          pills={<>
            {noise && <span className="wr-pill2 wr-pill2-amber" title="The change does not clear two standard errors of simulation noise">inside the noise</span>}
            {isGuess(s.title_odds_delta) && <span className="wr-pill2 wr-pill2-amber">guess</span>}
          </>} />
        <ValueEdge leagueId={leagueId} offer={{ partner: String(s.partner), give: s.give.map(String), get: s.get.map(String) }} />
      </div>

      <div className="wr-hero-acts">
        {!thread && !ajBanner && <CopyButton text={messageOf(s, partner, n)} primary onCopy={chosen ? undefined : onPick} />}
        {chosen && !thread && !ajBanner && (
          <button type="button" className="wr-btn wr-btn-lg" disabled={isSent} onClick={onMarkSent}
            title="Tell the planner you sent it in ESPN">
            {isSent ? 'Marked as sent' : 'I sent it'}
          </button>
        )}
        {onAskCoach && <button type="button" className="wr-link wr-hero-ask" onClick={onAskCoach}>Ask Coach about this</button>}
      </div>
      {thread}
    </article>
  );
}

type Namer = ReturnType<typeof namer>;
type Step = Move['steps'][number];

const messageOf = (s: Step, partner: string, n: Namer) =>
  (isOk(s.message) ? s.message.value : `Offer ${partner}: ${n.text(s.give)} for ${n.text(s.get)}`);

/**
 * The rest of the move, for the Details disclosure: the message to send, the walk-away
 * ladder, "If he says...", when to send, the reasoning and his screen. `onReply` logs his
 * actual answer once the card is picked (the deck's offer.reply).
 */
export function MoveDetails({ move, view, leagueId, onReply, negotiating }: {
  move: Move; view: WarRoomView; leagueId: number; onReply?: (reply: ReplyKind) => void; negotiating?: boolean;
}) {
  const n = namer(view.names);
  const s = move.steps[0];
  const partner = teamLabel(s.partner);
  // The path card above already names the target and the steps; the composer starts at the message.
  // Reasoning rows that are not computed are not drawn one by one: one line says how many wait.
  const rv = isOk(move.reasoning) ? move.reasoning.value : null;
  const ready = rv ? REASONING_SLOTS.filter(([k]) => rv[k]) : [];
  const waiting = REASONING_SLOTS.length - ready.length;
  return (
    <div className="wr-move-details" data-testid="move-details">
      {!negotiating && (
        <CopyBlock label={isOk(s.message) ? messageLabel(s) : 'Copy the deal'} text={messageOf(s, partner, n)}
          note={isOk(s.message) ? undefined : (s.message.reason ?? `Message ${NOT_COMPUTED}.`)} />
      )}
      <div className="wr-acc">
        <details className="wr-acc-i" data-acc="when">
          <summary><span className="wr-acc-t">When to send</span><span className="wr-acc-h"><Val f={s.send_when} fmt={v => v.split(':')[0]} /></span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
          <div className="wr-acc-b"><p className="wr-sub"><Val f={s.send_when} fmt={v => v} showReason /></p></div>
        </details>
        <details className="wr-acc-i" data-acc="walk">
          <summary><span className="wr-acc-t">Walk-away</span><span className="wr-acc-h"><WalkHint s={s} text={n.text} /></span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
          <div className="wr-acc-b"><Ladder s={s} text={n.text} /></div>
        </details>
        {!negotiating && (
          <details className="wr-acc-i" data-acc="replies">
            <summary><span className="wr-acc-t">If he says…</span><span className="wr-acc-h">{onReply ? 'tap what happened' : 'accept, decline, counter, silence'}</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
            <div className="wr-acc-b"><ReplyTable replies={s.reply_table} onLog={onReply} /></div>
          </details>
        )}
        <details className="wr-acc-i" data-acc="why">
          <summary><span className="wr-acc-t">Why this move</span>
            <span className="wr-acc-h">{waiting ? `${waiting} check${waiting === 1 ? '' : 's'} not ready yet` : 'all checks ready'}</span>
            <Icon name="down" size={16} className="wr-acc-chev" /></summary>
          <div className="wr-acc-b">
            {ready.length > 0 && rv && (
              <ul className="wr-reasoning">
                {ready.map(([k, label]) => <li key={k}><span className="wr-k">{label}</span><span>{rv[k]}</span></li>)}
              </ul>
            )}
            {waiting > 0 && <p className="wr-sub" data-testid="checks-waiting">{waiting} check{waiting === 1 ? '' : 's'} not ready yet{!isOk(move.reasoning) && move.reasoning.reason ? `: ${move.reasoning.reason}` : '.'}</p>}
            <p className="wr-sub">
              Whole path: <Val f={move.expected} fmt={pts} showSe /> expected
              {' · '}finishes <Val f={move.p_complete} fmt={v => pct(v)} /> of the time
              {' · '}finder&apos;s best single offer <Val f={view.finder_best_expected} fmt={pts} />
            </p>
            <HisScreenToggle leagueId={leagueId} offer={{ partner: String(s.partner), give: s.give.map(String), get: s.get.map(String) }} />
          </div>
        </details>
      </div>
    </div>
  );
}

/** The walk-away in the accordion header, so it reads without opening. */
function WalkHint({ s, text }: { s: Step; text: (ids: string[]) => string }) {
  return isOk(s.walk_away) ? <span>{text(s.walk_away.value.max_give)} for {text(s.get)}</span> : <Val f={s.walk_away} fmt={() => ''} />;
}


function Metric({ label, big, sub, pills, testid }: { label: string; big: ReactNode; sub?: ReactNode; pills?: ReactNode; testid: string }) {
  return (
    <div className="wr-metric" data-testid={testid}>
      <div className="wr-metric-l">{label}</div>
      <div className="wr-metric-v">{big}</div>
      {sub && <div className="wr-metric-s">{sub}</div>}
      {pills && <div className="wr-metric-p">{pills}</div>}
    </div>
  );
}

/** A big number: the formatted value when ok, else the designed unknown / failed state. No noise suffix (a pill says it). */
function BigVal({ f, fmt }: { f: Field<number> | undefined; fmt: (v: number) => string }) {
  return isOk(f) ? <CountUp to={f.value} fmt={fmt} /> : <Val f={f} fmt={fmt} />;
}

/** How long the value edge may load before it says so instead of a skeleton. */
export const VALUE_EDGE_WAIT_MS = 10_000;

/**
 * Value edge: the offer's market read from the his-screen route (precomputed for deck moves).
 * A read that has not answered in VALUE_EDGE_WAIT_MS reads "not available" with the reason,
 * never an endless skeleton; a late answer still replaces it.
 */
export function ValueEdge({ leagueId, offer, waitMs = VALUE_EDGE_WAIT_MS }: { leagueId: number; offer: { partner: string; give: string[]; get: string[] }; waitMs?: number }) {
  const path = hisScreenPath(leagueId, offer);
  const { data, loading, error } = useHisScreen(path);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  useEffect(() => {
    if (data || error) return;
    const t = setTimeout(() => setTimedOut(path), waitMs);
    return () => clearTimeout(t);
  }, [path, data, error, waitMs]);
  const market = data?.enabled && !data.error ? data.market : undefined;
  const slow = timedOut === path && !data && !error;
  const reason = error ?? data?.error ?? (data && !data.enabled ? data.reason : undefined)
    ?? (market && market.pct == null ? 'He gives nothing with a market value.' : undefined)
    ?? (slow ? `His screen has not answered in ${Math.round(waitMs / 1000)} s; open His screen to try again.` : undefined);
  const edge = market && market.pct != null ? valueEdgeText(market.pct) : null;
  return (
    <div className="wr-metric" data-testid="hero-value">
      <div className="wr-metric-l">Value edge</div>
      <div className={`wr-metric-v${edge ? ` wr-tone-${edge.tone}` : ''}`}>
        {edge ? edge.big : loading && !data && !slow ? <span className="wr-skel" role="status" aria-label="Loading the value edge" />
          : <span className="wr-unk" data-state="unknown" title={reason}>{slow ? 'not available' : NOT_COMPUTED}</span>}
      </div>
      <div className="wr-metric-s">{edge ? edge.note : slow ? 'still working it out' : null}</div>
    </div>
  );
}
