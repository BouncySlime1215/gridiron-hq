import { useEffect, useReducer, useRef, useState } from 'react';
import type { ReplyKind } from './types';
import { teamLabel } from './types';
import { Val, SourceTag } from './FieldState';
import { pct, pts, isOk } from './format';
import {
  closeNegotiation, counterSent, followedUp, logNegotiationReply, rescoreCounter, type Poster,
} from './requests';
import {
  countdownText, elapsed, pkgReducer, samePkg, screen, slot, span,
  type Pkg, type Rescore, type RosterPlayer, type Thread, type ThreadResponse,
} from './negotiate';

/**
 * NEGOTIATION MODE (WAR-ROOM-UI.md v3, new mode 1). After "I sent it" the card is a live
 * thread: his reply branches (the step's reply table as it was when the offer went out),
 * a countdown to "follow up" and then "move on" from his reply-time distribution, and a
 * counter builder where each edit is rescored on the server (one fast title-odds rescore
 * plus his side: chance of yes and his yes-point) with the walk-away line on the slider.
 * The server computes every number; this draws them. Nothing is ever sent from here.
 */
export default function Negotiate({ thread, onThread, post, now: fixedNow, initialRescore }: {
  thread: Thread;
  onThread: (t: Thread | null) => void;
  post?: Poster;
  now?: number;
  initialRescore?: Rescore;
}) {
  const [clock, setClock] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow != null) return;
    const t = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  const [error, setError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<'closed' | 'counter' | 'his_ask'>(initialRescore ? 'counter' : 'closed');
  const name = (id: string) => thread.names[id] ?? `Player ${id}`;
  const list = (ids: string[] | null) => (ids ?? []).map(name).join(' + ');
  const partner = teamLabel(thread.partner);
  const L = thread.league_id;

  const act = (p: Promise<unknown>) => p
    .then(r => { setError(null); onThread((r as ThreadResponse)?.thread ?? null); })
    .catch(e => setError(e instanceof Error ? e.message : String(e)));

  const sentAt = new Date(thread.sent_at);
  const since = sentAt.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const closed = thread.status === 'closed';
  const c = thread.countdown;
  const live = thread.branches.find(b => b.live) ?? null;

  const logReply = (kind: ReplyKind) => {
    if (kind === 'counter') { setBuilder('his_ask'); return; }
    void act(logNegotiationReply(L, thread.id, kind, null, post));
  };

  return (
    <section className="wr-neg" data-testid="negotiation" data-phase={c?.phase ?? thread.status}>
      <div className="wr-row">
        <b>{closed ? CLOSED_TEXT[thread.closed_reason ?? 'walked_away'] : `Waiting on ${partner} since ${since}`}</b>
        <span className="wr-sp" />
        {thread.can_undo && (
          <button type="button" className="wr-btn wr-sm" onClick={() => void act(closeNegotiation(L, thread.id, 'undone', post))}>Undo "I sent it"</button>
        )}
        {!closed && (
          <button type="button" className="wr-btn wr-sm" onClick={() => void act(closeNegotiation(L, thread.id, 'walked_away', post))}>Walk away</button>
        )}
      </div>
      <div className="wr-sub">Sent: you give {list(thread.give)}, you get {list(thread.get)}</div>

      {c && (
        <div className={`wr-clock wr-clock-${c.phase}`} data-testid="countdown">
          <div className="wr-row">
            <span>{countdownText(c, now)}</span>
            <span className="wr-sp" />
            {(c.phase === 'follow_up' || c.phase === 'move_on') && (
              <button type="button" className="wr-btn wr-sm wr-primary" onClick={() => void act(followedUp(L, thread.id, post))}>I followed up</button>
            )}
          </div>
          <div className="wr-bar" aria-hidden="true"><i style={{ width: `${Math.round(elapsed(c, now) * 100)}%` }} /></div>
          <div className="wr-hint">
            {c.typical_min != null && c.slow_min != null
              ? <>He usually answers in {span(c.typical_min)}, slow is {span(c.slow_min)} · </>
              : <>{c.reason} · </>}
            {c.basis} <span className="wr-tag">guess</span>
          </div>
        </div>
      )}

      <div className="wr-cap">His reply → what you do</div>
      <table className="wr-rt" aria-label="Reply branches">
        <tbody>
          {thread.branches.map(b => (
            <tr key={b.kind} className={b.live ? 'wr-sel' : undefined} data-branch={b.kind} data-live={b.live || undefined}>
              <td className="wr-rt-k">{b.label}</td>
              <td>
                <Val f={b.plan} fmt={r => r.do} showReason={b.live} />
                {isOk(b.plan) && b.plan.value.odds_after && (
                  <span className="wr-muted"> · title odds <Val f={b.plan.value.odds_after} fmt={v => pct(v, 1)} /></span>
                )}
              </td>
              {!closed && (
                <td><button type="button" className="wr-btn wr-sm" onClick={() => logReply(b.kind)}>He did this</button></td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {live && isOk(live.plan) && (
        <div className="wr-chosen" data-testid="live-branch">
          <b>{live.label}.</b> {live.plan.value.do}
          {live.plan.value.counter_rules && (
            <ul className="wr-rules">
              <li><span className="wr-k">Take it if</span> {live.plan.value.counter_rules.accept_if}</li>
              <li><span className="wr-k">Counter with</span> {live.plan.value.counter_rules.counter_with}</li>
              <li><span className="wr-k">Walk if</span> {live.plan.value.counter_rules.walk_away_if}</li>
            </ul>
          )}
          {live.plan.value.message && <p className="wr-msg-text">{live.plan.value.message}</p>}
        </div>
      )}

      {thread.events.length > 0 && (
        <ol className="wr-thread" aria-label="Thread">
          {thread.events.map((e, i) => (
            <li key={i}>
              <span className="wr-muted">{new Date(e.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>{' '}
              {e.kind === 'follow_up' ? 'You followed up'
                : e.kind === 'counter_sent' ? `You countered: give ${list(e.give)}, get ${list(e.get)}`
                  : e.give ? `He countered: wants ${list(e.give)}, gives ${list(e.get)}` : `He ${REPLY_TEXT[e.reply ?? 'silence']}`}
            </li>
          ))}
        </ol>
      )}

      {!closed && builder === 'closed' && (
        <div className="wr-acts">
          <button type="button" className="wr-btn" onClick={() => setBuilder('counter')}>Build a counter</button>
        </div>
      )}
      {!closed && builder !== 'closed' && (
        <CounterBuilder thread={thread} mode={builder} post={post} initial={initialRescore}
          onClose={() => setBuilder('closed')}
          onDone={p => { setBuilder('closed'); void act(p); }} />
      )}
      {error && <div className="wr-hint wr-red" role="status">Could not save that: {error}</div>}
    </section>
  );
}

const CLOSED_TEXT: Record<string, string> = {
  accepted: 'He accepted. Deal done.', declined: 'He declined.', walked_away: 'You walked away.', undone: '"I sent it" was undone.',
};
const REPLY_TEXT: Record<ReplyKind, string> = { accept: 'accepted', decline: 'declined', counter: 'countered', silence: 'has not replied' };

/**
 * The counter builder: tap players on either side; every edit is rescored by the server
 * (debounced, stale answers dropped). mode 'his_ask' records the package as his counter;
 * 'counter' records it as the counter Nick sent.
 */
function CounterBuilder({ thread, mode, post, initial, onClose, onDone }: {
  thread: Thread;
  mode: 'counter' | 'his_ask';
  post?: Poster;
  initial?: Rescore;
  onClose: () => void;
  onDone: (p: Promise<unknown>) => void;
}) {
  const sent: Pkg = { give: thread.give, get: thread.get };
  const [pkg, dispatch] = useReducer(pkgReducer, sent);
  const [score, setScore] = useState<Rescore | null>(initial ?? null);
  const [rosters, setRosters] = useState(initial?.rosters ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const L = thread.league_id;

  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      rescoreCounter(L, thread.id, pkg, rosters == null, post)
        .then(r => {
          if (mine !== seq.current) return;
          const s = r as Rescore;
          setScore(s); setError(null);
          if (s.rosters) setRosters(s.rosters);
        })
        .catch(e => { if (mine === seq.current) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, 120);
    return () => window.clearTimeout(t);
    // rosters is fetched once; an edit only resends the package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, thread.id, pkg.give.join(), pkg.get.join(), post]);

  const ok = score?.status === 'ok';
  const axis = score?.axis ?? { low: -35, high: 45 };
  const his = ok ? score.his : undefined;
  const nick = ok ? score.nick : undefined;
  const wa = ok ? score.walk_away : undefined;
  const chips = (side: 'give' | 'get', players: RosterPlayer[] | undefined) => (
    <div className="wr-chips" role="group" aria-label={side === 'give' ? 'You give' : 'You get'}>
      {(players ?? []).slice(0, 14).map(p => {
        const on = pkg[side].includes(p.id);
        return (
          <button type="button" key={p.id} className={on ? 'wr-chip wr-on' : 'wr-chip'} aria-pressed={on}
            onClick={() => dispatch({ type: 'toggle', side, id: p.id })}>{p.label}</button>
        );
      })}
      {!players && <span className="wr-hint">Loading rosters…</span>}
    </div>
  );

  return (
    <div className="wr-builder" data-testid="counter-builder">
      <div className="wr-row">
        <b>{mode === 'his_ask' ? 'What did he ask for?' : 'Build your counter'}</b>
        <span className="wr-sp" />
        <span className="wr-hint" data-testid="rescore-ms">
          {busy ? 'rescoring…' : ok && score.ms != null ? `rescored in ${score.ms} ms` : ''}
        </span>
        <button type="button" className="wr-btn wr-sm" onClick={onClose}>Close</button>
      </div>
      <div className="wr-cap">You give (tap to add or drop)</div>
      {chips('give', rosters?.mine)}
      <div className="wr-cap">You get from {teamLabel(thread.partner)}</div>
      {chips('get', rosters?.his)}

      {score?.status === 'failed' && <div className="wr-hint wr-red">{score.reason}</div>}
      <div className="wr-tiles">
        <div className="wr-tile">
          <div className="wr-l">Your title odds</div>
          <div className="wr-v"><Val f={nick?.title_odds_delta} fmt={pts} showSe /></div>
          <div className="wr-s">
            <Val f={nick?.title_before} fmt={v => pct(v, 1)} /> → <Val f={nick?.title_after} fmt={v => pct(v, 1)} />
          </div>
        </div>
        <div className="wr-tile">
          <div className="wr-l">Chance he says yes</div>
          <div className="wr-v wr-amber"><Val f={his?.p_yes} fmt={v => pct(v)} /></div>
          <div className="wr-s">
            {his?.p_yes?.band ? `${pct(his.p_yes.band.low)}–${pct(his.p_yes.band.high)} · ` : ''}
            {his?.p_yes && <SourceTag id={his.p_yes.source} />}
          </div>
        </div>
        <div className="wr-tile">
          <div className="wr-l">His yes-point</div>
          <div className="wr-v"><Val f={his?.yes_point} fmt={screen} /></div>
          <div className="wr-s">package now <Val f={his?.screen} fmt={screen} /> on his screen</div>
        </div>
      </div>

      <Slider axis={axis} his={his} walkAway={wa} />
      {his?.yes_point?.basis && <div className="wr-hint">Yes-point: {his.yes_point.basis}. <span className="wr-tag">guess</span></div>}

      <div className="wr-acts">
        {mode === 'his_ask' ? (
          <button type="button" className="wr-btn wr-primary" disabled={samePkg(pkg, sent)}
            onClick={() => onDone(logNegotiationReply(L, thread.id, 'counter', pkg, post))}>Log this as his counter</button>
        ) : (
          <button type="button" className="wr-btn wr-primary" disabled={samePkg(pkg, sent)}
            onClick={() => onDone(counterSent(L, thread.id, pkg, post))}>I sent this counter</button>
        )}
        <span className="wr-hint">Copy it into ESPN yourself; nothing is sent from here.</span>
      </div>
      {error && <div className="wr-hint wr-red" role="status">Could not rescore: {error}</div>}
    </div>
  );
}

/** His screen as a slider: the package, his yes-point, and your walk-away line. Positions only. */
function Slider({ axis, his, walkAway }: {
  axis: { low: number; high: number };
  his?: Rescore['his'];
  walkAway?: Rescore['walk_away'];
}) {
  const mark = (v: number | undefined) => (v == null ? null : slot(v, axis));
  const at = mark(his && isOk(his.screen) ? his.screen.value : undefined);
  const yes = mark(his && isOk(his.yes_point) ? his.yes_point.value : undefined);
  const walk = mark(walkAway && isOk(walkAway) ? walkAway.value : undefined);
  const walkText = walkAway?.text;
  return (
    <div className="wr-slider" data-testid="screen-slider" role="img"
      aria-label="Where the package sits on his screen, with his yes-point and your walk-away">
      <div className="wr-track">
        {yes && <span className="wr-mk wr-mk-yes" style={{ left: `${yes.left}%` }} data-testid="yes-point" title="His yes-point" />}
        {walk && <span className="wr-mk wr-mk-walk" style={{ left: `${walk.left}%` }} data-testid="walk-away-line" title="Your walk-away" />}
        {at && <span className="wr-mk wr-mk-at" style={{ left: `${at.left}%` }} data-testid="package-dot" title="This package" />}
      </div>
      <div className="wr-row wr-hint">
        <span>{screen(axis.low)} he loses value</span>
        <span className="wr-sp" />
        <span>he gains value {screen(axis.high)}</span>
      </div>
      <div className="wr-hint">
        {walkAway && isOk(walkAway)
          ? <>Red line: your walk-away ({walkText ?? screen(walkAway.value)}). Past it, your backup plan is worth more.</>
          : <>No walk-away line: {walkAway?.reason ?? 'not priced for this step.'}</>}
      </div>
    </div>
  );
}
