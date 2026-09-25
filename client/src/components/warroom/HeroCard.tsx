import type { ReactNode } from 'react';
import type { Field, Move, ReplyKind, WarRoomView } from './types';
import { REASONING_SLOTS, namer, teamLabel } from './types';
import { Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import ReplyTable from './ReplyTable';
import { HisScreenToggle, hisScreenPath } from './HisScreen';
import { useHisScreen } from './useWarRoom';
import { CopyBlock, CopyButton, Ladder, messageLabel } from './cardParts';
import { heroStatus, isGuess, playerParts, valueEdgeText } from './heroStatus';
import Avatar from './Avatar';
import CountUp from './CountUp';

/**
 * WAR-ROOM-UI v2: the NEXT MOVE as one clean hero card. Only what decides the send is
 * on it: who, what Nick gives and gets (big player chips), the status badge with its
 * one-line reason (heroStatus.ts), three big numbers (chance he says yes, title odds
 * before -> after, value edge), one Copy-message button and "Ask Coach about this".
 * Everything else about the move (message text, walk-away, replies, reasoning) is
 * MoveDetails, drawn behind the page's one Details disclosure. NextMoveDeck owns the
 * deck state and every post; this file only draws and calls back.
 */
export default function HeroCard({ move, view, leagueId, chosen, isSent, thread, onPick, onMarkSent, onAskCoach }: {
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
}) {
  const n = namer(view.names);
  const s = move.steps[0];
  const partner = teamLabel(s.partner);
  const status = heroStatus(s);
  const titleNow = isOk(view.destination) ? view.destination.value.title_now : undefined;
  const noise = isOk(s.title_odds_delta) && s.title_odds_delta.clears_2se === false;
  const both = isOk(titleNow) && isOk(s.title_after);

  return (
    <article className="wr-hero-card" data-testid="hero-card" aria-label="Next move">
      <div className="wr-hero-head">
        <div className="wr-hero-partner">
          <span className="wr-k">Next move · send to</span>
          <h2 className="wr-hero-who">{partner}</h2>
        </div>
        <span className={`wr-status wr-status-${status.tone}`} data-testid="hero-status" data-tone={status.tone}
          title={status.reasons.length ? `Why not yet: ${status.reasons.join('; ')}` : 'Nothing shown is a guess and the gain clears 2 SE.'}>
          {status.label}
        </span>
      </div>

      <div className="wr-hero-deal">
        <Side label="You give" ids={s.give} n={n} side="give" />
        <span className="wr-hero-arrow" aria-hidden>→</span>
        <Side label="You get" ids={s.get} n={n} side="get" />
      </div>

      <div className="wr-hero-nums">
        <Metric label="Chance he says yes" testid="hero-chance"
          big={<BigVal f={s.p_yes} fmt={v => pct(v)} />}
          pills={isGuess(s.p_yes) ? <span className="wr-pill2 wr-pill2-amber" title="Built on an unvalidated model: treat as a guess">guess</span> : null} />
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
        {!thread && <CopyButton text={messageOf(s, partner, n)} primary onCopy={chosen ? undefined : onPick} />}
        {chosen && !thread && (
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
  const target = move.target != null ? n.one(move.target) : null;
  return (
    <div className="wr-move-details" data-testid="move-details">
      <p className="wr-sub">
        {target && <>Step 1 of {move.steps.length} toward <b>{target.name}</b>{move.target_owner ? ` (${teamLabel(move.target_owner)})` : ''}. </>}
        When to send: <Val f={s.send_when} fmt={v => v} />
      </p>
      {!negotiating && (
        <CopyBlock label={isOk(s.message) ? messageLabel(s) : 'Copy the deal'} text={messageOf(s, partner, n)}
          note={isOk(s.message) ? undefined : (s.message.reason ?? `Message ${NOT_COMPUTED}.`)} />
      )}
      <h3 className="wr-cap">Walk-away</h3>
      <Ladder s={s} text={n.text} />
      {!negotiating && <>
        <h3 className="wr-cap">If he says… {onReply ? '(tap what happened)' : ''}</h3>
        <ReplyTable replies={s.reply_table} onLog={onReply} />
      </>}
      <h3 className="wr-cap">Why this move</h3>
      <ul className="wr-reasoning">
        {REASONING_SLOTS.map(([k, label]) => (
          <li key={k}><span className="wr-k">{label}</span>
            {isOk(move.reasoning) ? <span>{move.reasoning.value[k]}</span> : <Val f={move.reasoning} fmt={() => ''} />}
          </li>
        ))}
      </ul>
      <p className="wr-sub">
        Whole path: <Val f={move.expected} fmt={pts} showSe /> expected
        {' · '}finishes <Val f={move.p_complete} fmt={v => pct(v)} /> of the time
        {' · '}finder&apos;s best single offer <Val f={view.finder_best_expected} fmt={pts} />
      </p>
      <HisScreenToggle leagueId={leagueId} offer={{ partner: String(s.partner), give: s.give.map(String), get: s.get.map(String) }} />
    </div>
  );
}

function Side({ label, ids, n, side }: { label: string; ids: string[]; n: Namer; side: 'give' | 'get' }) {
  return (
    <div className="wr-hero-side" data-side={side}>
      <div className="wr-k">{label}</div>
      <div className="wr-pchips">
        {ids.map(id => {
          const p = playerParts(n.one(id).name);
          return (
            <span key={id} className="wr-pchip" data-player={id} title={n.one(id).name}>
              <Avatar id={id} name={p.name} size={44} />
              <span className="wr-pchip-n">{p.name}</span>
              {p.pos && <span className="wr-pchip-p">{p.pos}</span>}
            </span>
          );
        })}
        {!ids.length && <span className="wr-muted">nothing</span>}
      </div>
    </div>
  );
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

/** Value edge: the offer's market read from the his-screen route (precomputed for deck moves). */
function ValueEdge({ leagueId, offer }: { leagueId: number; offer: { partner: string; give: string[]; get: string[] } }) {
  const { data, loading, error } = useHisScreen(hisScreenPath(leagueId, offer));
  const market = data?.enabled && !data.error ? data.market : undefined;
  const reason = error ?? data?.error ?? (data && !data.enabled ? data.reason : undefined)
    ?? (market && market.pct == null ? 'He gives nothing with a market value.' : undefined);
  const edge = market && market.pct != null ? valueEdgeText(market.pct) : null;
  return (
    <div className="wr-metric" data-testid="hero-value">
      <div className="wr-metric-l">Value edge</div>
      <div className={`wr-metric-v${edge ? ` wr-tone-${edge.tone}` : ''}`}>
        {edge ? edge.big : loading && !data ? <span className="wr-skel" role="status" aria-label="Loading the value edge" />
          : <span className="wr-unk" data-state="unknown" title={reason}>{NOT_COMPUTED}</span>}
      </div>
      <div className="wr-metric-s">{edge ? edge.note : null}</div>
    </div>
  );
}
