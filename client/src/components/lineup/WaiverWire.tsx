import { useState } from 'react';
import type { ReactNode } from 'react';
import { PageLoading, PageError } from '../PageState';

/**
 * The waiver wire, on the page where the lineup is set.
 *
 * Reads GET /api/trades/:leagueId/waivers (server/services/waiver-wire.js#waiverBoard).
 * Two lists with two different questions, kept visibly apart:
 *
 *   Claims now — ranked on points added to THIS WEEK's starting lineup
 *                (current_week_ppg), after the server's cut: never someone worth
 *                more over the rest of the season than the claim, never one whose
 *                loss lowers the rest-of-season lineup (waiver-wire.js#chooseClaimCut).
 *                Claims with no such cut are held back and counted.
 *   Stashes    — no help this week, ranked on points added to the
 *                REST-OF-SEASON lineup, with their own cut.
 *
 * The server can pick a different drop for each list, and the page says so rather
 * than showing one "drop" as if there were a single answer. Free agents with no NFL
 * team are left off the board by the server and only counted here.
 */

export interface WaiverRow {
  player: string; position: string; team?: string | null;
  projected_ppg: number; ros_ppg?: number | null;
  injury_status?: string | null; active_probability?: number | null;
  upgrade: number; would_start?: boolean;
  drop_candidate?: { player: string; position: string; ppg: number | null; ros_ppg?: number | null } | null;
  /** What the claim and its cut do to the rest-of-season lineup (never negative). */
  ros_change?: number | null;
  ros_upgrade?: number | null;
  ros_drop_candidate?: { player: string; position: string; ros_ppg: number | null } | null;
}

export interface WaiverBoard {
  error?: string;
  season?: number; week?: number;
  immediate?: WaiverRow[]; stashes?: WaiverRow[];
  live_players?: number; roster_size?: number; on_ir?: string[];
  free_agents_considered?: number; baseline_points?: number;
  drop_rule?: string;
  held_back?: HeldBack[]; held_back_count?: number;
  teamless_excluded?: number;
  note?: string;
}

/** A free agent who would help this week, but only by cutting someone worth more over the season. */
export interface HeldBack {
  player: string; position: string; team?: string | null; ros_ppg?: number | null;
  week_upgrade: number;
  would_cut: { player: string; position: string; ppg: number | null; ros_ppg: number | null };
  why: string;
}

/** Rostered players the lineup solver will not start, by lower-cased name → why. */
export type OutList = Map<string, string>;

const SHOWN = 3;

/**
 * Free agents with no NFL team: the server now leaves them off the board and
 * returns only a count (`teamless_excluded`). On the 2026-W2 sync they were 17 of
 * the 21 stash rows across five leagues — every one of league 2's ten, all
 * out-of-work or retired quarterbacks carrying 13-16 point rest-of-season figures
 * and 0 this week. A player without a team cannot score until someone signs him.
 * The filter stays as a guard for a response from an older server.
 */
export const onATeam = (r: WaiverRow) => !!r.team;
const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

/**
 * The claim fills a slot the lineup is currently scoring nothing in — an empty
 * spot, or a starter projected for zero. Derived, not guessed: the upgrade is
 * his whole projection only if nobody with points was pushed out to fit him.
 */
const fillsHole = (r: WaiverRow) =>
  r.projected_ppg > 0 && Math.abs(r.upgrade - r.projected_ppg) < 0.015;

/** One cut shared by every row shown, or null when the rows disagree. */
function sharedDrop<T extends { player: string }>(list: (T | null | undefined)[]): T | null {
  const first = list[0];
  if (!first) return null;
  return list.every(d => d?.player === first.player) ? first : null;
}

export default function WaiverWire({ data, loading, error, onRetry, out }: {
  data: WaiverBoard | null; loading: boolean; error: string | null; onRetry: () => void; out: OutList;
}) {
  return (
    <section id="waiver-wire" className="tr-rise scroll-mt-16 rounded-2xl border border-slate-200 bg-white p-4"
      style={{ animationDelay: '190ms' }} aria-labelledby="waivers-heading">
      <h2 id="waivers-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">Waiver wire</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Ranked by what a claim adds to your starting lineup, not by the player's raw projection. In five replayed
        seasons, making the best claim each week added about 2 to 3.5 percentage points of win rate against the
        whole league (less the more of your league does it too), and it helped in all five.
      </p>
      <Body data={data} loading={loading} error={error} onRetry={onRetry} out={out} />
    </section>
  );
}

function Body({ data, loading, error, onRetry, out }: {
  data: WaiverBoard | null; loading: boolean; error: string | null; onRetry: () => void; out: OutList;
}) {
  const [showAll, setShowAll] = useState(false);
  if (loading && !data) return <PageLoading label="Checking every free agent against your lineup…" />;
  if (error && !data) return <div className="mt-3"><PageError message={error} onRetry={onRetry} /></div>;
  if (!data) return null;
  if (data.error) {
    return <p className="mt-2 text-sm leading-6 text-slate-600">No waiver board for this league right now: {data.error}.</p>;
  }

  const immediate = (data.immediate ?? []).filter(onATeam);
  const stashes = (data.stashes ?? []).filter(onATeam);
  const teamless = data.teamless_excluded ?? 0;
  const heldBack = data.held_back ?? [];
  const heldCount = data.held_back_count ?? heldBack.length;
  const shown = showAll ? immediate : immediate.slice(0, SHOWN);
  const drop = sharedDrop(shown.map(r => r.drop_candidate));
  const rosDrop = sharedDrop(stashes.map(r => r.ros_drop_candidate));
  const weekDropName = sharedDrop(immediate.map(r => r.drop_candidate))?.player ?? null;

  return (
    <>
      {/* ---------------------------------------------------------- claims now */}
      <div className="mt-3">
        <div className="text-[10px] font-black uppercase tracking-wide text-emerald-700">
          Claim now · helps this week
        </div>
        {immediate.length === 0 ? (
          <p className="mt-1.5 text-sm leading-6 text-slate-600">
            {heldCount > 0
              ? 'No free agent improves this week\'s lineup without cutting someone worth more over the rest of the season.'
              : 'No free agent would improve this week\'s starting lineup — none projects above the starter he would replace.'}
          </p>
        ) : (
          <>
            {drop && <DropLine label="To make room, drop" who={drop.player} pos={drop.position}
              detail={out.get(drop.player.toLowerCase())
                ?? `${fmt(drop.ppg)} projected this week · ${fmt(drop.ros_ppg)} a week rest of season`} />}
            <div className="mt-2 divide-y divide-slate-100">
              {shown.map((r, i) => (
                <ClaimRow key={`${r.player}-${i}`} r={r} value={r.upgrade} valueLabel="this week"
                  sub={`Projects ${fmt(r.projected_ppg)} this week`}
                  hole={fillsHole(r)} marginal={r.upgrade < 1}
                  perRowDrop={drop ? null : r.drop_candidate
                    ? `drop ${r.drop_candidate.player} (${r.drop_candidate.position})` : null} />
              ))}
            </div>
            {immediate.length > SHOWN && (
              <button type="button" onClick={() => setShowAll(v => !v)}
                className="btn-ghost mt-2 w-full text-xs font-semibold sm:w-auto">
                {showAll ? 'Show fewer' : `Show all ${immediate.length} claims that help this week`}
              </button>
            )}
          </>
        )}
        {heldBack.length > 0 && (
          // The claims the cut rule stopped: they help this Sunday only by releasing
          // someone worth more over the rest of the season. Named, with the cut, so
          // "why isn't X suggested" has an answer on the page.
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
            <b className="text-slate-800">Held back ({heldCount}):</b>{' '}
            {heldBack.slice(0, 2).map((h, i) => (
              <span key={`${h.player}-${i}`}>
                {i > 0 ? '; ' : ''}{h.player} would add +{fmt(h.week_upgrade)} this week{' '}
                {(h.would_cut.ros_ppg ?? 0) > (h.ros_ppg ?? 0)
                  ? <>but only by cutting {h.would_cut.player} ({fmt(h.would_cut.ros_ppg)} a week rest of season vs
                    his {fmt(h.ros_ppg)})</>
                  // The other reason a claim is held: every cut that keeps the week gain
                  // lowers the rest-of-season lineup (waiver-wire.js rule (b)).
                  : <>but every cut that keeps that gain lowers your rest-of-season lineup</>}
              </span>
            ))}
            {heldCount > 2 ? `; and ${heldCount - 2} more` : ''}.
          </div>
        )}
        {data.drop_rule && (immediate.length > 0 || heldBack.length > 0) && (
          <p className="mt-1.5 text-[11px] leading-4 text-slate-400">{data.drop_rule}</p>
        )}
      </div>

      {/* ------------------------------------------------------------- stashes */}
      <details className="group mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer list-none text-sm font-bold text-slate-800 [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline justify-between gap-2">
            <span>Stashes · rest of season ({stashes.length})</span>
            <span className="text-xs font-normal text-slate-400 group-open:hidden">Show</span>
            <span className="hidden text-xs font-normal text-slate-400 group-open:inline">Hide</span>
          </span>
          <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-500">
            No help this Sunday; a better lineup for the weeks after. Ranked on the rest of the season.
          </span>
        </summary>
        {stashes.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {/* The server keeps anyone who helps THIS week out of the stash list, so
                the claims above may well improve the rest of the season too. */}
            {`${immediate.length > 0 ? 'Beyond the claims above, no' : 'No'} free agent improves your rest-of-season lineup.`}
          </p>
        ) : (
          <>
            {rosDrop && (
              <DropLine label="To make room, drop" who={rosDrop.player} pos={rosDrop.position}
                detail={out.get(rosDrop.player.toLowerCase())
                  ?? `${fmt(rosDrop.ros_ppg)} a week projected rest of season`}
                differs={weekDropName != null && weekDropName !== rosDrop.player
                  ? `A different cut from the claims above: a stash cuts your weakest rest-of-season bench player, ${rosDrop.player}; the claims above cut ${weekDropName}, the cut that keeps this week's gain at the least cost to the rest of the season.`
                  : null} />
            )}
            <div className="mt-2 divide-y divide-slate-200">
              {stashes.map((r, i) => (
                <ClaimRow key={`${r.player}-${i}`} r={r} value={r.ros_upgrade ?? 0} valueLabel="a week, rest of season"
                  sub={`Rest of season ${fmt(r.ros_ppg)} a week · this week ${fmt(r.projected_ppg)}`}
                  hole={false} marginal={false}
                  perRowDrop={rosDrop ? null : r.ros_drop_candidate
                    ? `drop ${r.ros_drop_candidate.player} (${r.ros_drop_candidate.position})` : null} />
              ))}
            </div>
          </>
        )}
      </details>

      {/* ------------------------------------------------------------ footnote */}
      <p className="mt-3 text-[11px] leading-4 text-slate-400">
        {data.free_agents_considered != null && <>Checked {data.free_agents_considered} free agents. </>}
        {data.live_players != null && data.roster_size != null && (
          <>{data.live_players} of your {data.roster_size} active players are likely to suit up and see the ball this week. </>
        )}
        {(data.on_ir?.length ?? 0) > 0 && (
          <>On IR and never suggested as a cut: {data.on_ir!.join(', ')}.</>
        )}
      </p>
      {teamless > 0 && (
        <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
          Left off: {teamless} free agent{teamless === 1 ? '' : 's'} with no NFL team. They cannot score until
          someone signs them, so a rest-of-season number cannot describe a real role.
        </p>
      )}
    </>
  );
}

function DropLine({ label, who, pos, detail, differs }: {
  label: string; who: string; pos: string; detail: string; differs?: string | null;
}) {
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-sm leading-5 text-slate-700">
        {label} <b className="text-slate-950">{who}</b> <span className="text-xs text-slate-400">{pos}</span>
      </p>
      <p className="text-xs leading-5 text-slate-500">{detail}</p>
      {differs && <p className="mt-1 text-xs leading-5 text-amber-900">{differs}</p>}
    </div>
  );
}

function ClaimRow({ r, value, valueLabel, sub, hole, marginal, perRowDrop }: {
  r: WaiverRow; value: number; valueLabel: string; sub: string;
  hole: boolean; marginal: boolean; perRowDrop: string | null;
}) {
  // The injury report's status (Questionable / Doubtful / Out); its "Note" rows and
  // blanks carry no designation, so they get no chip.
  const injury = r.injury_status && !['ACTIVE', 'NOTE'].includes(r.injury_status.toUpperCase())
    ? r.injury_status.replace(/_/g, ' ').toLowerCase() : null;
  const plays = r.active_probability != null && r.active_probability < 0.6
    ? Math.round(r.active_probability * 100) : null;
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-black text-slate-950">{r.player}</span>
          <span className="text-xs text-slate-400">
            <span className={`pos-${r.position} font-semibold`}>{r.position}</span>{r.team ? ` · ${r.team}` : ' · no team'}
          </span>
        </div>
        <div className="mt-0.5 text-xs leading-5 text-slate-500">
          {sub}{perRowDrop ? ` · ${perRowDrop}` : ''}
        </div>
        {(hole || marginal || injury || plays != null) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {hole && (
              <Chip cls="bg-rose-50 text-rose-800 ring-rose-200">Fills a spot you score 0 in now</Chip>
            )}
            {marginal && (
              <Chip cls="bg-amber-50 text-amber-900 ring-amber-200">Under a point: a coin flip</Chip>
            )}
            {injury && <Chip cls="bg-rose-50 text-rose-800 ring-rose-200">{injury}</Chip>}
            {plays != null && (
              // active_probability is this week's chance to play in every case: from
              // the injury report when there is a designation (Out is about 0.001),
              // otherwise from the availability model (contingency.js). It is the
              // number this week's projection is multiplied by, not a share of weeks.
              <Chip cls="bg-amber-50 text-amber-900 ring-amber-200">
                {`about ${plays}% to play this week`}
              </Chip>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-base font-black tabular-nums text-good">+{fmt(value)}</div>
        <div className="text-[10px] leading-3 text-slate-400">{valueLabel}</div>
      </div>
    </div>
  );
}

const Chip = ({ cls, children }: { cls: string; children: ReactNode }) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${cls}`}>{children}</span>
);

/**
 * One line near the top of the page when a claim would change this week's
 * lineup, pointing down to the full board — so the lineup stays first on a
 * phone without the week's best move being buried under it.
 */
export function WaiverTeaser({ data }: { data: WaiverBoard | null }) {
  const top = data?.immediate?.find(onATeam);
  if (!top) return null;
  return (
    <a href="#waiver-wire"
      onClick={e => {
        // Scroll in place rather than letting the router see a hash change.
        const el = document.getElementById('waiver-wire');
        if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }}
      className="tr-rise flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 hover:border-slate-300"
      style={{ animationDelay: '70ms' }}>
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-slate-950">Waiver claim available:</span>{' '}
        {top.player} <span className="text-xs text-slate-400">{top.position}</span> adds{' '}
        <b className="text-good">+{fmt(top.upgrade)}</b> to this week's lineup
        {fillsHole(top) ? ', filling a spot you score 0 in now' : ''}.
      </span>
      <span className="shrink-0 text-xs font-semibold text-slate-500" aria-hidden="true">↓</span>
    </a>
  );
}
