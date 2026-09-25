import { useState } from 'react';
import type { Move, Target, WarRoomView } from './types';
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
export default function ScreenGoGet({ view, leagueId, current, onRequest }: {
  view: WarRoomView; leagueId: number; current: CurrentMove | null;
  onRequest?: (req: WarRoomRequest) => Promise<unknown>;
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
    <div className="wr-goget">
      <section className="wr-card2" data-panel="targets" aria-label="Pick a target">
        <h3 className="wr-card2-h"><span className="wr-stepno">1</span>Pick who to go get</h3>
        <FieldBlock f={field} label="Suggested targets">
          {() => (
            <>
              <div className="wr-tgrid" role="listbox" aria-label="Targets">
                {targets.map(t => (
                  <TargetCard key={t.player} t={t} name={n.one(t.player).name} on={t.player === sel}
                    onPick={() => { setPicked(t.player); setPathId(null); }}
                    state={t.is_plan_target ? 'plan' : t.approved || asked[t.player] === 'saved' ? 'approved' : asked[t.player] === 'saving' ? 'saving' : null}
                    onApprove={onRequest ? () => approve(t.player) : undefined} />
                ))}
              </div>
              {!targets.length && <div className="wr-empty">No suggested targets in this run.</div>}
              {hiddenUt.length > 0 && (
                <div className="wr-hint" data-testid="targets-untouchable" title={hiddenUt.map(h => `${n.one(h.player).name}: ${h.label}`).join('\n')}>
                  {hiddenUt.length} hidden: {hiddenUt.map(h => `${n.one(h.player).name} (${teamLabel(h.owner)}, ${h.label})`).join('; ')}
                </div>
              )}
              {error && <div className="wr-hint wr-red" role="status">Could not save the approval: {error}</div>}
            </>
          )}
        </FieldBlock>
      </section>

      <section className="wr-card2" data-panel="paths" aria-label="Paths">
        <h3 className="wr-card2-h"><span className="wr-stepno">2</span>{sel ? <>Paths to {n.one(sel).name}</> : "The plan's moves"}
          {sel && <button type="button" className="wr-link wr-h-note" onClick={() => { setPicked(null); setPathId(null); }}>Show every plan move</button>}
        </h3>
        {!paths.length && !sel ? <div className="wr-empty">The planner has no move this week.</div>
          : !paths.length && sel ? (
            <div className="wr-empty" role="status">
              No plan leads to {n.one(sel).name} yet.{' '}
              {selTarget && !isOk(selTarget.p_reach) && selTarget.p_reach.reason ? selTarget.p_reach.reason : 'Approve him and the next planner run plans toward him.'}
            </div>
          ) : (
            <div className="wr-paths">
              {paths.map(m => (
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
                            chance <Val f={s.p_yes} fmt={v => pct(v)} />{isGuess(s.p_yes) && <span className="wr-pill2 wr-pill2-amber">guess</span>}
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
      </section>

      {path && (
        <section className="wr-card2" data-panel="composer" aria-label="The offer">
          <h3 className="wr-card2-h"><span className="wr-stepno">3</span>The offer to {teamLabel(path.steps[0].partner)}</h3>
          <MoveDetails move={path} view={view} leagueId={leagueId}
            onReply={current?.move.move_id === path.move_id ? current.onReply : undefined}
            negotiating={current?.move.move_id === path.move_id ? current.negotiating : false} />
        </section>
      )}

      <section className="wr-card2" data-panel="stops" aria-label="Your plan">
        <h3 className="wr-card2-h">Your plan, stop by stop</h3>
        <Itinerary field={view.itinerary} big />
      </section>
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

function TargetCard({ t, name, on, onPick, state, onApprove }: {
  t: Target; name: string; on: boolean; onPick: () => void;
  state: 'plan' | 'approved' | 'saving' | null; onApprove?: () => void;
}) {
  return (
    <div className={`wr-tcard${on ? ' wr-on' : ''}`} role="option" aria-selected={on} data-target-player={t.player}
      title={isOk(t.why) ? t.why.value : t.why.reason}>
      <button type="button" className="wr-tcard-main" onClick={onPick} aria-label={`Show paths to ${name}`}>
        <Avatar id={t.player} name={name} size={48} />
        <span className="wr-tcard-t">
          <b className="wr-tcard-n" title={name}>{name}</b>
          <span className="wr-tcard-o">{teamLabel(t.owner)}</span>
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
    </div>
  );
}
