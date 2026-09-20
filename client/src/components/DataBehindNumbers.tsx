import BasisChip from './ui/BasisChip';
import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { useLeague } from '../state/league';

/**
 * What the projections are actually computed from, and what is missing.
 *
 * The app has one failure mode it repeats: healthy-looking and not working. The
 * live case this card exists for is `POST /api/model/sync` having run its season
 * list as `[SEASON-5 … SEASON-1]`, so every completed season was re-fetched and
 * the season being played never was. `player_week_usage` held about eight
 * thousand rows for each prior year and zero for the current one, every source
 * reported `ok`, and nothing on any screen was different: the projections simply
 * carried on being computed from last year. The counts that would have shown it
 * were served by `/api/model/status` the whole time and rendered on a page that
 * has since been deleted.
 *
 * So this is not a dashboard. It answers one question — is this season's data in
 * here — and it is loudest in the case where nothing else in the app is.
 *
 * It deliberately does not restate what other surfaces already say: Start/Sit
 * carries the chance-to-play basis, and each league card carries its own roster
 * sync time and sync errors. Two accounts of one number is how they drift.
 */

interface Status {
  usage_seasons: { season: number; rows: number; players: number }[];
  lines: { season: number; n: number }[];
  players_with_gsis: number;
  correlations_fitted: number;
  gamescript_fitted: number;
}

const n = (value: number) => value.toLocaleString();

function SeasonChips({ seasons, missing }: { seasons: number[]; missing: number | null }) {
  if (!seasons.length && missing == null) return <span className="text-slate-400">nothing loaded</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {seasons.map(s => (
        <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{s}</span>
      ))}
      {missing != null && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200">
          {missing} — nothing yet
        </span>
      )}
    </span>
  );
}

export default function DataBehindNumbers() {
  const { active } = useLeague();
  const { data, error } = useApi<Status>('/model/status');
  if (error || !data) return null;

  const usage = [...(data.usage_seasons ?? [])].sort((a, b) => a.season - b.season);
  const loaded = usage.filter(s => s.rows > 0);
  // The season to ask about is the one the user is actually playing, taken from
  // the league itself rather than from the calendar — draft-assist.js reads the
  // calendar year for this and is wrong every January.
  const season = active?.season ?? null;
  const thisSeason = season == null ? null : usage.find(s => s.season === season) ?? null;
  const missingThisSeason = season != null && (thisSeason?.rows ?? 0) === 0;
  const lines = [...(data.lines ?? [])].sort((a, b) => a.season - b.season);
  // Per row, whether THIS season is in it. The card already lists which seasons
  // are loaded; what it never said in one glance is whether the season being
  // played is one of them, and that is the live failure mode — the model falls
  // back to the most recent season it has and says nothing, so the app looks
  // completely healthy while projecting this year off last year's football.
  const linesThisSeason = season != null && (lines.find(l => l.season === season)?.n ?? 0) > 0;

  return (
    <div className="card p-5 mb-4 space-y-3">
      <h2 className="text-lg font-bold">Data behind these numbers</h2>
      <p className="text-xs leading-5 text-slate-600">
        Every projection, start/sit call and trade value is computed from what is listed here. A
        season missing from this list does not make anything fail — the model uses the most recent
        one it has and says nothing about it, which is how the app can look completely healthy while
        projecting this year off last year's football.
      </p>

      {missingThisSeason && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 ring-1 ring-amber-200">
          No {season} player usage is loaded
          {active?.current_week ? `, and your league is on week ${active.current_week}` : ''}. Not one
          snap played this season is in the numbers you are looking at; the usage side of every
          projection comes from earlier years. Run a model sync to pull it in — the seasons it
          fetches include the one being played.
        </p>
      )}

      <dl className="space-y-2 text-xs">
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="w-44 shrink-0 font-semibold text-slate-700">Player usage</dt>
          <dd className="flex-1 flex flex-wrap items-center gap-2">
            <SeasonChips seasons={loaded.map(s => s.season)} missing={missingThisSeason ? season : null} />
            {season != null && <BasisChip basis={missingThisSeason ? 'missing' : 'measured'} />}
          </dd>
        </div>
        {thisSeason && thisSeason.rows > 0 && (
          <div className="flex flex-wrap items-baseline gap-2">
            <dt className="w-44 shrink-0 font-semibold text-slate-700">{season} so far</dt>
            <dd className="flex-1 text-slate-600">{n(thisSeason.rows)} player-weeks across {n(thisSeason.players)} players</dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="w-44 shrink-0 font-semibold text-slate-700">Game lines</dt>
          <dd className="flex-1 flex flex-wrap items-center gap-2">
            <SeasonChips seasons={lines.filter(l => l.n > 0).map(l => l.season)} missing={season != null && !linesThisSeason ? season : null} />
            {season != null && <BasisChip basis={linesThisSeason ? 'measured' : 'missing'} />}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="w-44 shrink-0 font-semibold text-slate-700">Matched to the stat feed</dt>
          {/* A player with no gsis_id has no usage history to project from, whatever
              else is loaded, so this number is a ceiling on everything above. */}
          <dd className="flex-1 text-slate-600">{n(data.players_with_gsis)} players</dd>
        </div>
      </dl>

      <p className="text-[11px] leading-5 text-slate-500">
        Which availability model prices each chance to play is shown on{' '}
        <Link className="font-semibold text-emerald-700" to="/lineup">Start/Sit</Link>. When each
        league's rosters were last pulled, and any sync that failed, is on{' '}
        <Link className="font-semibold text-emerald-700" to="/league?view=connections">My Leagues</Link>.
      </p>
    </div>
  );
}
