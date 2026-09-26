import { useEffect, useState, type ReactNode } from 'react';
import type { BuyLow, Move, Target, WarRoomView } from './types';
import { namer, teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, isOk } from './format';
import { targetApprove, type WarRoomRequest } from './requests';
import { isUntouchable } from './TargetPicker';
import Itinerary from './Itinerary';
import Avatar from './Avatar';
import { MoveDetails } from './HeroCard';
import type { CurrentMove } from './NextMoveDeck';
import { isGuess } from './heroStatus';
import Icon, { EmptyState } from './icons';
import BlueChipBoard from './BlueChipBoard';
import ChanceStat from './ChanceStat';
import { AjAllowToggle, ajOnMyRoster, boardScore, BLUE_CHIP, type AjPicks } from './AjPick';

const FIT: Record<string, string> = { fits: 'fits your mode', needs_all_in: 'needs all-in', too_risky_for_safe: 'too risky for safe' };

/** The plan's moves that lead to `player`: aimed at him, or a step that gets him. */
export function pathsTo(moves: Move[], player: string): Move[] {
  return moves.filter(m => m.target === player || m.steps.some(s => s.get.map(String).includes(player)));
}

/**
 * WAR-ROOM-UI v2, GO GET: a guided flow. 1 pick a target (photos, gain if landed,
 * reachability), 2 its paths as step timelines (partner, give / get, chance, gain),
 * 3 the offer composer for the chosen path (message, walk-away, "If he says..."). The
 * plan's stops sit under it. Approve writes one target.approve request, as the classic
 * Targets panel does; nothing else is written here.
 */
export default function ScreenGoGet({ view, leagueId, current, onRequest, someoneElse, compact = false, aj = null }: {
  view: WarRoomView; leagueId: number; current: CurrentMove | null;
  onRequest?: (req: WarRoomRequest) => Promise<unknown>;
  /** Trades → Go get: "Someone else?" (a name search) closes the target list. */
  someoneElse?: ReactNode;
  /** Trades → Go get: one plan shown (the rest behind Show more) and the offer folded until a plan is picked. */
  compact?: boolean;
  /** AJ-PICK (Trades): Nick's picks for A.J. Brown; a Blue chip target card gets the "Allow A.J. for him" toggle. */
  aj?: AjPicks | null;
}) {
  const n = namer(view.names);
  const field = view.targets;
  const targets = isOk(field) ? field.value.filter(t => !isUntouchable(t)) : [];
  const hiddenUt = isOk(field) ? [
    ...(view.targets?.hidden_untouchable ?? []),
    ...field.value.filter(isUntouchable).map(t => ({ player: t.player, owner: t.owner, label: t.untouchable_label ?? 'on his untouchable list' })),
  ] : [];
  const moves = isOk(view.alternatives) ? view.alternatives.value : [];
  // Opens on the plan's own target when a move leads to him; otherwise on every plan move.
  const planTarget = targets.find(t => t.is_plan_target)?.player
    ?? (isOk(view.next_move) ? view.next_move.value.target : null) ?? null;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const sel = picked !== undefined ? picked : planTarget && pathsTo(moves, planTarget).length ? planTarget : null;
  const paths = sel ? pathsTo(moves, sel) : moves;
  const [pathId, setPathId] = useState<string | null>(null);
  const path = paths.find(m => m.move_id === pathId) ?? paths[0] ?? null;
  const selTarget = targets.find(t => t.player === sel) ?? null;
  const ajToggleFor = (player: string) => !!aj?.enabled && ajOnMyRoster(view) && (boardScore(view, player) ?? -1) >= BLUE_CHIP;

  // The sections under the fold (composer, blue chips, stops) render one task later, so the
  // switch to this screen paints the targets and paths in one short frame.
  const [rest, setRest] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const id = window.requestAnimationFrame(() => { t = setTimeout(() => setRest(true), 0); });
    return () => { window.cancelAnimationFrame(id); if (t) clearTimeout(t); };
  }, []);

  // Three target cards at first; the rest behind "Show more" (always including the one picked).
  const [allTargets, setAllTargets] = useState(false);
  const selIdx = sel ? targets.findIndex(t => t.player === sel) : -1;
  const shownTargets = allTargets || selIdx >= 3 ? targets : targets.slice(0, 3);
  // Two plans side by side on a wide screen, one on a phone; the rest behind "Show more".
  const [allPaths, setAllPaths] = useState(false);
  const [phone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 699px)').matches);
  const shownPaths = allPaths ? paths : paths.slice(0, phone || compact ? 1 : 2);

  const [asked, setAsked] = useState<Record<string, 'saving' | 'saved'>>({});
  const [error, setError] = useState<string | null>(null);
  const approve = (player: string) => {
    if (!onRequest) return;
    setAsked(a => ({ ...a, [player]: 'saving' }));
    onRequest(targetApprove(player))
      .then(() => { setAsked(a => ({ ...a, [player]: 'saved' })); setError(null); })
      .catch(e => {
        setAsked(a => { const { [player]: _drop, ...rest } = a; return rest; });
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className={`wr-goget${compact ? ' wr-goget-compact' : ''}`}>
      <section className="wr-card2" data-panel="targets" aria-label="Pick a target">
        <h3 className="wr-card2-h"><span className="wr-stepno">1</span>Pick who to go get</h3>
        <FieldBlock f={field} label="Suggested targets">
          {() => (
            <>
              <div className="wr-tgrid wr-stagger" role="listbox" aria-label="Targets">
                {shownTargets.map(t => (
                  <TargetCard key={t.player} t={t} name={n.one(t.player).name} on={t.player === sel}
                    onPick={() => { setPicked(t.player); setPathId(null); }}
                    state={t.is_plan_target ? 'plan' : t.approved || asked[t.player] === 'saved' ? 'approved' : asked[t.player] === 'saving' ? 'saving' : null}
                    onApprove={onRequest ? () => approve(t.player) : undefined}
                    aj={aj && ajToggleFor(t.player) ? <AjAllowToggle player={t.player} name={n.one(t.player).name} picks={aj} /> : null} />
                ))}
              </div>
              {shownTargets.length < targets.length && (
                <button type="button" className="wr-more" onClick={() => setAllTargets(true)} data-testid="targets-more">
                  Show {targets.length - shownTargets.length} more target{targets.length - shownTargets.length === 1 ? '' : 's'}
                </button>
              )}
              {!targets.length && <EmptyState icon="target" title="No suggested targets in this run." />}
              {hiddenUt.length > 0 && (
                <div className="wr-hint" data-testid="targets-untouchable" title={hiddenUt.map(h => `${n.one(h.player).name}: ${h.label}`).join('\n')}>
                  {hiddenUt.length} hidden: {hiddenUt.map(h => `${n.one(h.player).name} (${teamLabel(h.owner)}, ${h.label})`).join('; ')}
                </div>
              )}
              {error && <div className="wr-hint wr-red" role="status">Could not save the approval: {error}</div>}
            </>
          )}
        </FieldBlock>
        {someoneElse && <div className="wr-someone" data-testid="goget-someone-else">{someoneElse}</div>}
      </section>

      <section className="wr-card2" data-panel="paths" aria-label="Paths">
        <h3 className="wr-card2-h"><span className="wr-stepno">2</span>{sel ? <>Paths to {n.one(sel).name}</> : "The plan's moves"}
          {sel && <button type="button" className="wr-link wr-h-note" onClick={() => { setPicked(null); setPathId(null); }}>Show every plan move</button>}
        </h3>
        {!paths.length && !sel ? <EmptyState icon="inbox" title="The planner has no move this week." />
          : !paths.length && sel ? (
            <EmptyState icon="search" title={<>No plan leads to {n.one(sel).name} yet.</>}>
              {selTarget && !isOk(selTarget.p_reach) && selTarget.p_reach.reason ? selTarget.p_reach.reason : 'Approve him and the next planner run plans toward him.'}
            </EmptyState>
          ) : (
            <div className="wr-paths wr-stagger">
              {shownPaths.map(m => (
                <div key={m.move_id} role="button" tabIndex={0} className={`wr-path${path?.move_id === m.move_id ? ' wr-on' : ''}`}
                  aria-pressed={path?.move_id === m.move_id} onClick={() => setPathId(m.move_id)} data-path={m.move_id}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPathId(m.move_id); } }}>
                  <span className="wr-path-h">
                    <b>{m.rank === 1 ? 'Best plan' : `Plan ${m.rank}`}</b>
                    <span className="wr-muted"> · finishes <Val f={m.p_complete} fmt={v => pct(v)} /> · <Val f={m.expected} fmt={pts} /> expected</span>
                  </span>
                  <ol className="wr-timeline">
                    {m.steps.map((s, i) => (
                      <li key={i}>
                        <span className="wr-tl-dot" aria-hidden>{i + 1}</span>
                        <span className="wr-tl-b">
                          <span className="wr-tl-who">{teamLabel(s.partner)}</span>
                          <span className="wr-tl-deal">
                            <Faces ids={s.give} n={n} /> <span className="wr-muted">for</span> <Faces ids={s.get} n={n} />
                          </span>
                          <span className="wr-tl-nums">
                            {isOk(s.p_yes) ? <ChanceStat label="chance" value={s.p_yes.value} guess={isGuess(s.p_yes)} />
                              : <>chance <Val f={s.p_yes} fmt={v => pct(v)} /></>}
                            {' · '}gain <Val f={s.title_odds_delta} fmt={pts} />
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
        {paths.length > shownPaths.length && (
          <button type="button" className="wr-more" onClick={() => setAllPaths(true)} data-testid="paths-more">
            Show {paths.length - shownPaths.length} more plan{paths.length - shownPaths.length === 1 ? '' : 's'}
          </button>
        )}
      </section>

      {!rest && <div className="wr-card2 wr-defer" aria-hidden><span className="wr-skel wr-skel-line" /><span className="wr-skel wr-skel-line wr-skel-short" /></div>}
      {rest && path && (compact ? (
        // Folded until a plan is picked: the view opens on who to go get and the best plan.
        <details className="wr-card2 wr-fold" data-panel="composer" aria-label="The offer" open={!!pathId} key={pathId ?? 'none'}>
          <summary><span className="wr-card2-h"><span className="wr-stepno">3</span>The offer to {teamLabel(path.steps[0].partner)}</span>
            <span className="wr-h-note">message, when to send, walk-away, if he says…</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
          <MoveDetails move={path} view={view} leagueId={leagueId}
            onReply={current?.move.move_id === path.move_id ? current.onReply : undefined}
            negotiating={current?.move.move_id === path.move_id ? current.negotiating : false} />
        </details>
      ) : (
        <section className="wr-card2" data-panel="composer" aria-label="The offer">
          <h3 className="wr-card2-h"><span className="wr-stepno">3</span>The offer to {teamLabel(path.steps[0].partner)}</h3>
          <MoveDetails move={path} view={view} leagueId={leagueId}
            onReply={current?.move.move_id === path.move_id ? current.onReply : undefined}
            negotiating={current?.move.move_id === path.move_id ? current.negotiating : false} />
        </section>
      ))}

      {rest && compact ? (
        // Trades: one fold for the reference lists, so the view opens on the decision.
        <details className="wr-card2 wr-fold" data-panel="more" aria-label="Blue chips and your plan">
          <summary><span className="wr-card2-h">Blue chips and your plan</span>
            <span className="wr-h-note">who to go get, risers, protected players; {isOk(view.itinerary) ? `${view.itinerary.value.stops_left} stops left` : 'the plan'}</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
          {view.blue_chips && isOk(view.blue_chips) && <div data-panel="blue_chips"><BlueChipBoard field={view.blue_chips} big /></div>}
          <div data-panel="stops" className="mt-4"><Itinerary field={view.itinerary} big /></div>
        </details>
      ) : <>
      {rest && view.blue_chips && isOk(view.blue_chips) && (
        <details className="wr-card2 wr-fold" data-panel="blue_chips" aria-label="Blue chips">
          <summary><span className="wr-card2-h">Blue chips</span><span className="wr-h-note">who to go get, risers, your protected players</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
          <BlueChipBoard field={view.blue_chips} big />
        </details>
      )}

      {rest && <details className="wr-card2 wr-fold" data-panel="stops" aria-label="Your plan">
        <summary><span className="wr-card2-h">Your plan, stop by stop</span>
          <span className="wr-h-note">{isOk(view.itinerary) ? `${view.itinerary.value.stops_left} left` : ''}</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
        <Itinerary field={view.itinerary} big />
      </details>}
      </>}
    </div>
  );
}

function Faces({ ids, n }: { ids: string[]; n: ReturnType<typeof namer> }) {
  return (
    <span className="wr-faces">
      {ids.map(id => (
        <span key={id} className="wr-face" title={n.one(id).name}>
          <Avatar id={id} name={n.one(id).name} size={28} />
          <span className="wr-face-n">{n.one(id).name}</span>
        </span>
      ))}
    </span>
  );
}

/** BUY-LOW: served only with its flag on; the War Room's own pill (as "in the plan"), a plain-words title, no numbers on the card. */
export function BuyLowChip({ b }: { b: BuyLow }) {
  const role = b.role === 'confirmed' ? `usage up in ${b.games} recent games, `
    : b.role === 'detected' ? 'usage up in his latest game, ' : '';
  return (
    <span className="wr-tcard-bl" data-testid="target-buy-low">
      <span className="wr-pill2 wr-pill2-green" title={`Buy-low (a guess): ${role}scoring about ${b.points_below_expected} pts/game below what his usage predicts over his last ${b.games} games.`}>Buy-low</span>
    </span>
  );
}

function TargetCard({ t, name, on, onPick, state, onApprove, aj = null }: {
  t: Target; name: string; on: boolean; onPick: () => void;
  state: 'plan' | 'approved' | 'saving' | null; onApprove?: () => void;
  aj?: ReactNode;
}) {
  return (
    <div className={`wr-tcard${on ? ' wr-on' : ''}`} role="option" aria-selected={on} data-target-player={t.player}
      title={isOk(t.why) ? t.why.value : t.why.reason}>
      <button type="button" className="wr-tcard-main" onClick={onPick} aria-label={`Show paths to ${name}`}>
        <Avatar id={t.player} name={name} size={48} />
        <span className="wr-tcard-t">
          <b className="wr-tcard-n" title={name}>{name}</b>
          <span className="wr-tcard-o">{teamLabel(t.owner)}</span>
          {isOk(t.buy_low) && t.buy_low.value && <BuyLowChip b={t.buy_low.value} />}
        </span>
      </button>
      <div className="wr-tcard-nums">
        <span><span className="wr-l2">If landed</span><b><Val f={t.gain_if_landed} fmt={pts} /></b></span>
        <span><span className="wr-l2">Reachable</span><b><Val f={t.p_reach} fmt={v => pct(v)} /></b></span>
      </div>
      <div className="wr-tcard-f">
        <span className="wr-muted"><Val f={t.mode_fit} fmt={v => FIT[v] ?? v} /></span>
        {state === 'plan' ? <span className="wr-pill2 wr-pill2-accent">in the plan</span>
          : state === 'approved' ? <span className="wr-pill2">approved</span>
          : <button type="button" className="wr-btn wr-sm" disabled={!onApprove || state === 'saving'}
              title={!onApprove ? 'Approving is not wired on this page' : 'The next planner run plans toward him'}
              onClick={onApprove}>{state === 'saving' ? 'Saving…' : 'Approve'}</button>}
      </div>
      {aj && <div className="wr-tcard-aj">{aj}</div>}
    </div>
  );
}
