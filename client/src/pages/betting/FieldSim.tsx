import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api';

/**
 * The drive, drawn.
 *
 * Every number this app produces comes from a simulator that resolves each snap
 * individually — down, distance, field position, play type, yardage, formation.
 * That tape was being thrown away and only its total reported. This draws it:
 * eleven on eleven, the ball moving the distance the engine actually gave it.
 *
 * It is not decoration. Watching a drive stall on three straight incompletions
 * from the fourteen tells you something about the model that "drive result:
 * field goal" does not, and the formations are the league's real ones — taken
 * from nflverse participation charting rather than invented for the picture.
 */

interface Play {
  down: number; to_go: number; yard_line: number;
  play_type: string; is_pass: boolean; yards: number;
  turnover: string | null; shotgun: boolean; seconds: number;
  direction: 'left' | 'middle' | 'right' | null; depth: 'short' | 'deep' | null;
  formation?: 'SHOTGUN' | 'UNDER CENTER' | 'PISTOL';
  personnel?: '11' | '12' | '21';
  defenders_in_box?: number;
  play_number?: number; quarter?: number; quarter_seconds?: number; game_clock?: string;
}
interface Drive {
  id?: number; half: number | string; possession: string; team_drive_number?: number;
  start_yard: number; points: number;
  result: string; plays: number; seconds: number; tape: Play[];
  clock_start?: { quarter: number; quarter_seconds: number; game_clock: string };
  clock_end?: { quarter: number; quarter_seconds: number; game_clock: string };
  score_before?: { home: number; away: number }; score_after?: { home: number; away: number };
}
interface DriveSet {
  home: string; away: string; drives_with_plays: number; drives: Drive[];
  season?: number; profile_fell_back?: boolean;
  play_model?: { version: string; formation_sampling: string; state_tracking: string };
  note: string; error?: string;
}

interface FieldSimProps {
  home?: string; away?: string;
  onHomeChange?: (team: string) => void; onAwayChange?: (team: string) => void;
}

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
  'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WSH'];

/*
 * Field geometry, vertical. The offence attacks UPWARD, which is the view a
 * coach draws a play from and the one that makes a route concept legible —
 * depth reads as distance up the page instead of sideways across it.
 *
 * `toY` inverts, so yard line 0 (own goal line) sits at the bottom and 100
 * (the end zone being attacked) at the top.
 */
const YARD = 7;               // px per yard
const EZ = 10 * YARD;         // end-zone depth
const H = EZ * 2 + 100 * YARD;
const W = 300;                // field width
const HASH_L = W * 0.36, HASH_R = W * 0.64;
const toY = (yardLine: number) => H - EZ - yardLine * YARD;

/**
 * Where eleven offensive players stand at the snap.
 *
 * Shotgun pulls the quarterback five yards back and spreads the receivers;
 * under centre tightens the formation and puts a back behind him. The line is
 * always five, because it always is.
 */
function offenseFormation(y: number, formation: string, personnel: string) {
  const mid = W / 2;
  // Five linemen across the width, always, because it always is.
  const line = [-2, -1, 0, 1, 2].map(i => ({ x: mid + i * 15, y: y + 3, kind: 'ol' as const }));

  // Quarterback depth is what distinguishes these three, and vertically it reads
  // as literal distance behind the ball. Shotgun about five yards, pistol four,
  // under centre right behind the snap.
  const qbDepth = formation === 'SHOTGUN' ? 38 : formation === 'PISTOL' ? 30 : 11;
  const qb = { x: mid, y: y + qbDepth, kind: 'qb' as const };

  // Pistol is defined by the back sitting BEHIND the quarterback rather than
  // beside him — that is the whole point of the formation, and it only reads
  // correctly in this orientation.
  const rb = formation === 'SHOTGUN' ? { x: mid + 24, y: y + 38, kind: 'rb' as const }
    : formation === 'PISTOL' ? { x: mid, y: y + 52, kind: 'rb' as const }
      : { x: mid, y: y + 30, kind: 'rb' as const };

  // Personnel decides how many tight ends and receivers are on the field.
  // 11 personnel is one back, one tight end, three receivers — 43% of snaps.
  const tes = personnel === '12' ? 2 : 1;
  const wrCount = personnel === '11' ? 3 : 2;
  const teSpots = [{ x: mid - 32, y: y + 3 }, { x: mid + 32, y: y + 3 }].slice(0, tes)
    .map(t => ({ ...t, kind: 'te' as const }));
  const spread = formation !== 'UNDER CENTER';
  const wrSpots = [
    { x: mid - (spread ? 108 : 92), y: y + 2 },
    { x: mid + (spread ? 108 : 88), y: y + 2 },
    { x: mid - (spread ? 74 : 62), y: y + 9 }
  ].slice(0, wrCount).map(w => ({ ...w, kind: 'wr' as const }));

  const backs = personnel === '21'
    ? [{ x: mid - 22, y: y + (formation === 'UNDER CENTER' ? 22 : 38), kind: 'rb' as const }] : [];

  return [...line, qb, rb, ...backs, ...teSpots, ...wrSpots];
}

/** Defenders mirror the offence across the line, deeper on obvious pass downs. */
function defenseFormation(y: number, expectPass: boolean, box: number) {
  const mid = W / 2;
  // The box count is real, measured data: shotgun draws 5.96 defenders into the
  // box on average and under centre draws 7.0. Four linemen are constant; the
  // remainder of the box is linebackers walked up, and whoever is left plays
  // deep. That is what a box count physically means.
  const inBox = Math.max(4, Math.min(8, Math.round(box)));
  const dl = [-1.5, -0.5, 0.5, 1.5].map(i => ({ x: mid + i * 17, y: y - 8, kind: 'dl' as const }));
  const boxLb = inBox - 4;
  const lb = Array.from({ length: Math.max(0, boxLb) }, (_, i) => ({
    x: mid + (i - (boxLb - 1) / 2) * 40,
    y: y - (expectPass ? 34 : 22), kind: 'lb' as const
  }));
  // Whoever is not in the box plays coverage. With a light box that is five
  // defensive backs, not four — the fifth is the nickel, and omitting him fielded
  // a ten-man defence, which is the kind of error a picture makes obvious and a
  // number never would.
  const remaining = Math.max(0, 11 - dl.length - lb.length);
  const secondary = [
    { x: mid - 108, y: y - 12 },                                  // boundary corner
    { x: mid + 108, y: y - 12 },                                  // field corner
    { x: mid - 44, y: y - (expectPass ? 88 : 62) },               // free safety
    { x: mid + 44, y: y - (expectPass ? 88 : 62) },               // strong safety
    { x: mid - 74, y: y - (expectPass ? 40 : 30) },               // nickel
    { x: mid + 74, y: y - (expectPass ? 40 : 30) }                // dime
  ];
  const db = secondary.slice(0, remaining).map(d => ({ ...d, kind: 'db' as const }));
  return [...dl, ...lb, ...db];
}

const RESULT_TONE: Record<string, string> = {
  touchdown: 'text-emerald-700', 'field goal': 'text-sky-700', punt: 'text-slate-500',
  interception: 'text-rose-700', fumble: 'text-rose-700', safety: 'text-rose-700'
};

export default function FieldSim({ home: selectedHome, away: selectedAway,
  onHomeChange, onAwayChange }: FieldSimProps = {}) {
  const [localHome, setLocalHome] = useState('KC');
  const [localAway, setLocalAway] = useState('BUF');
  const home = selectedHome ?? localHome;
  const away = selectedAway ?? localAway;
  const [seed, setSeed] = useState(7);
  const [focus, setFocus] = useState('all');
  const [driveIdx, setDriveIdx] = useState(0);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);   // 0..1 through the current play
  const raf = useRef<number | null>(null);

  const { data, loading } = useApi<DriveSet>(
    `/nfl-betting/sim/drive?home=${home}&away=${away}&seed=${seed}`);

  const drives = data?.drives ?? [];
  const eligibleDriveIndexes = useMemo(() => drives.map((drive, index) => ({ drive, index }))
    .filter(({ drive }) => focus === 'all' || (drive.possession === 'home' ? home : away) === focus)
    .map(({ index }) => index), [drives, focus, home, away]);
  const drive = drives[driveIdx];
  const tape = drive?.tape ?? [];
  const play = tape[playIdx];

  // Animate the ball across the yardage the engine actually produced.
  useEffect(() => {
    if (!playing || !play) return;
    let start: number | null = null;
    const duration = 900;
    const step = (t: number) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / duration);
      setProgress(p);
      if (p < 1) { raf.current = requestAnimationFrame(step); return; }
      // Hold briefly on the result, then advance.
      window.setTimeout(() => {
        setProgress(0);
        setPlayIdx(i => {
          if (i + 1 < tape.length) return i + 1;
          setPlaying(false);
          return i;
        });
      }, 420);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, playIdx, play, tape.length]);

  useEffect(() => { setPlayIdx(0); setProgress(0); setPlaying(false); }, [driveIdx, seed, home, away]);
  useEffect(() => {
    if (!eligibleDriveIndexes.includes(driveIdx)) setDriveIdx(eligibleDriveIndexes[0] ?? 0);
  }, [eligibleDriveIndexes, driveIdx]);

  const setHome = (team: string) => { setLocalHome(team); onHomeChange?.(team); };
  const setAway = (team: string) => { setLocalAway(team); onAwayChange?.(team); };
  const finalScore = drives.at(-1)?.score_after;
  const teamSummary = useMemo(() => [
    { team: away, side: 'away', drives: drives.filter(d => d.possession === 'away').length,
      plays: drives.filter(d => d.possession === 'away').reduce((sum, d) => sum + d.plays, 0), score: finalScore?.away ?? 0 },
    { team: home, side: 'home', drives: drives.filter(d => d.possession === 'home').length,
      plays: drives.filter(d => d.possession === 'home').reduce((sum, d) => sum + d.plays, 0), score: finalScore?.home ?? 0 }
  ], [drives, away, home, finalScore?.away, finalScore?.home]);

  const snapY = play ? toY(play.yard_line) : toY(25);
  const endY = play ? toY(Math.max(0, Math.min(100, play.yard_line + play.yards))) : snapY;
  const ballY = snapY + (endY - snapY) * progress;
  const expectPass = play ? (play.down >= 3 || play.to_go >= 7) : false;

  const formation = play?.formation ?? (play?.shotgun ? 'SHOTGUN' : 'UNDER CENTER');
  const personnel = play?.personnel ?? '11';
  const box = play?.defenders_in_box ?? (formation === 'UNDER CENTER' ? 7 : 6);
  const offense = useMemo(() => offenseFormation(snapY, formation, personnel),
    [snapY, formation, personnel]);
  const defense = useMemo(() => defenseFormation(snapY, expectPass, box),
    [snapY, expectPass, box]);

  // Lateral movement of the ball. A run cuts slightly; a pass breaks toward the
  // side it was thrown to.
  const ballX = useMemo(() => {
    const mid = W / 2;
    if (!play) return mid;
    if (!play.is_pass) return mid + Math.sin(progress * Math.PI) * 14;
    const target = play.direction === 'left' ? mid - 84
      : play.direction === 'right' ? mid + 84 : mid;
    return mid + (target - mid) * progress;
  }, [play, progress]);

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-700">Team-selected field replay</div>
            <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">Play-by-play game room</h2></div>
          {data?.play_model && <div className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-bold text-slate-500">{data.play_model.version}</div>}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Pick the matchup, then focus the tape on either offense or keep every possession. Team
          shotgun tendency, down, distance, game script and the called play now determine the formation;
          every snap retains its score, quarter, clock and field position.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[110px_110px_180px_minmax(240px,1fr)_auto_auto]">
          <label className="text-xs font-medium text-slate-500">Home
            <select value={home} onChange={e => setHome(e.target.value)} aria-label="Home team"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              {TEAMS.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Away
            <select value={away} onChange={e => setAway(e.target.value)} aria-label="Away team"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              {TEAMS.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Show plays for
            <select value={focus} onChange={e => setFocus(e.target.value)} aria-label="Show play-by-play for team"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm font-semibold text-slate-900">
              <option value="all">Both teams</option>
              <option value={away}>{away} offense</option>
              <option value={home}>{home} offense</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Possession
            <select value={driveIdx} onChange={e => setDriveIdx(Number(e.target.value))}
              aria-label="Select possession" className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              {eligibleDriveIndexes.map(i => {
                const d = drives[i];
                return (
                <option key={i} value={i}>
                  {i + 1}. {d.clock_start ? `Q${d.clock_start.quarter} ${d.clock_start.game_clock}` : `H${d.half}`} · {d.possession === 'home' ? home : away} · {d.result}
                </option>
                );
              })}
            </select>
          </label>
          <button onClick={() => setSeed(Math.floor(Math.random() * 1e6))}
            className="self-end rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            New game
          </button>
          <button onClick={() => { setPlaying(p => !p); }} disabled={!tape.length}
            className="self-end rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
            {playing ? 'Pause' : 'Play drive'}
          </button>
        </div>
      </div>

      {loading && !data && <div className="card p-6 text-sm text-slate-500">Simulating a game…</div>}
      {data?.error && <div className="card p-6 text-sm text-rose-700">{data.error}</div>}

      {drive && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {teamSummary.map(team => <button key={team.side} onClick={() => setFocus(team.team)}
              className={`rounded-2xl border p-4 text-left transition ${focus === team.team ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
              <div className="flex items-center justify-between"><span className="text-xs font-black uppercase tracking-wide text-slate-500">{team.side}</span><span className="text-3xl font-black tabular-nums text-slate-950">{team.score}</span></div>
              <div className="mt-1 text-lg font-black text-slate-900">{team.team}</div>
              <div className="text-xs text-slate-500">{team.drives} possessions · {team.plays} recorded snaps</div>
            </button>)}
          </div>

          <div className="card overflow-x-auto p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
              <div><div className="text-xs font-black uppercase tracking-wide text-emerald-700">{drive.possession === 'home' ? home : away} ball</div>
                <div className="text-sm font-semibold text-slate-900">{drive.clock_start ? `Q${drive.clock_start.quarter} · ${drive.clock_start.game_clock}` : `Half ${drive.half}`} · {formatFieldPosition(drive.start_yard)}</div></div>
              <div className="rounded-xl bg-slate-950 px-3 py-2 font-mono text-sm font-black text-white">{away} {drive.score_after?.away ?? 0} · {home} {drive.score_after?.home ?? 0}</div>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block" style={{ maxHeight: 620 }}
              role="img" aria-label="Simulated football play">
              <rect x={0} y={0} width={W} height={H} fill="#14532d" />
              {/* End zones: the one being attacked is at the top. */}
              <rect x={0} y={0} width={W} height={EZ} fill="#166534" />
              <rect x={0} y={H - EZ} width={W} height={EZ} fill="#166534" />
              <text x={W / 2} y={43} fill="#dcfce7" fontSize={18} fontWeight={900} textAnchor="middle" letterSpacing={3}>{drive.possession === 'home' ? home : away}</text>

              {/* Yard lines run across the field. */}
              {Array.from({ length: 21 }, (_, i) => i * 5).map(y => (
                <line key={y} x1={0} y1={toY(y)} x2={W} y2={toY(y)}
                  stroke="#ffffff" strokeOpacity={y % 10 === 0 ? 0.55 : 0.25}
                  strokeWidth={y % 10 === 0 ? 2 : 1} />
              ))}
              {Array.from({ length: 9 }, (_, i) => (i + 1) * 10).map(y => (
                <g key={y}>
                  <text x={20} y={toY(y) + 5} fill="#ffffff" fillOpacity={0.6}
                    fontSize={14} textAnchor="middle" fontFamily="monospace">
                    {y <= 50 ? y : 100 - y}
                  </text>
                  <text x={W - 20} y={toY(y) + 5} fill="#ffffff" fillOpacity={0.6}
                    fontSize={14} textAnchor="middle" fontFamily="monospace">
                    {y <= 50 ? y : 100 - y}
                  </text>
                </g>
              ))}
              {Array.from({ length: 99 }, (_, i) => i + 1).filter(y => y % 5 !== 0).map(y => (
                <g key={`h${y}`}>
                  <line x1={HASH_L - 5} y1={toY(y)} x2={HASH_L + 5} y2={toY(y)}
                    stroke="#fff" strokeOpacity={0.35} />
                  <line x1={HASH_R - 5} y1={toY(y)} x2={HASH_R + 5} y2={toY(y)}
                    stroke="#fff" strokeOpacity={0.35} />
                </g>
              ))}

              {/* Line of scrimmage and the line to gain. */}
              {play && (
                <>
                  <line x1={0} y1={snapY} x2={W} y2={snapY} stroke="#38bdf8" strokeWidth={3} />
                  <line x1={0} y1={toY(Math.min(100, play.yard_line + play.to_go))}
                    x2={W} y2={toY(Math.min(100, play.yard_line + play.to_go))}
                    stroke="#fbbf24" strokeWidth={3} strokeDasharray="7 5" />
                </>
              )}

              {defense.map((d, i) => (
                <circle key={`d${i}`} cx={d.x} cy={d.y} r={7} fill="#fca5a5"
                  stroke="#7f1d1d" strokeWidth={2} />
              ))}
              {offense.map((o, i) => (
                o.kind === 'ol'
                  ? <rect key={`o${i}`} x={o.x - 6} y={o.y - 6} width={12} height={12}
                    fill="#e2e8f0" stroke="#1e293b" strokeWidth={2} />
                  : <g key={`o${i}`}>
                    <circle cx={o.x} cy={o.y} r={8} fill="#f8fafc" stroke="#1e293b" strokeWidth={2} />
                    <text x={o.x} y={o.y + 4} fontSize={9} textAnchor="middle"
                      fill="#0f172a" fontFamily="monospace">
                      {o.kind === 'qb' ? 'Q' : o.kind === 'rb' ? 'R' : o.kind === 'te' ? 'T' : 'W'}
                    </text>
                  </g>
              ))}

              <ellipse cx={ballX} cy={ballY} rx={4.5} ry={7} fill="#a16207"
                stroke="#fef3c7" strokeWidth={1.5} />
            </svg>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="card p-4 lg:col-span-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  Possession {driveIdx + 1} · {drive.possession === 'home' ? home : away}
                </h3>
                <span className={`text-sm font-semibold ${resultTone(drive.result)}`}>
                  {drive.result} {drive.points > 0 && `(${drive.points})`}
                </span>
              </div>
              {play && (
                <p className="mt-2 font-mono text-sm text-slate-800">
                  {play.game_clock && `Q${play.quarter} ${play.game_clock} · `}{play.down} &amp; {play.to_go} · {formatFieldPosition(play.yard_line)}
                  {' · '}{(play.formation ?? '').toLowerCase() || (play.shotgun ? 'shotgun' : 'under centre')}
                  {' · '}{play.personnel ?? '11'} personnel
                  {' · '}{box} in the box
                  {' · '}{play.play_type.replace(/_/g, ' ')}
                  {play.direction ? ` ${play.depth} ${play.direction}` : ''}
                  {' → '}
                  <span className={play.yards > 0 ? 'text-emerald-700' : 'text-rose-700'}>
                    {play.yards > 0 ? '+' : ''}{play.yards} yd
                  </span>
                  {play.turnover && <span className="text-rose-700"> · {play.turnover}</span>}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-1">
                {tape.map((p, i) => (
                  <button key={i} onClick={() => { setPlayIdx(i); setProgress(0); setPlaying(false); }}
                    className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                      i === playIdx ? 'bg-sky-600 text-white'
                        : p.yards >= 10 ? 'bg-emerald-50 text-emerald-800'
                          : p.yards < 0 ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>
                    {i + 1}. {p.yards > 0 ? '+' : ''}{p.yards}
                  </button>
                ))}
              </div>
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-900">This drive</h3>
              <dl className="mt-2 space-y-1 text-sm">
                <Row k="Started" v={formatFieldPosition(drive.start_yard)} />
                <Row k="Plays" v={String(drive.plays)} />
                <Row k="Elapsed" v={`${Math.floor(drive.seconds / 60)}:${String(drive.seconds % 60).padStart(2, '0')}`} />
                <Row k="Result" v={drive.result} />
                {drive.score_after && <Row k="Score after" v={`${away} ${drive.score_after.away} · ${home} ${drive.score_after.home}`} />}
              </dl>
              <p className="mt-3 text-xs text-slate-500">{data?.note}</p>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="font-black text-slate-900">Play-by-play · {drive.possession === 'home' ? home : away} possession {drive.team_drive_number ?? driveIdx + 1}</div>
              <div className="text-xs text-slate-500">Select any snap to move the field to that down and distance.</div>
            </div>
            <div className="divide-y divide-slate-100">
              {tape.map((p, i) => <button key={i} onClick={() => { setPlayIdx(i); setProgress(0); setPlaying(false); }}
                className={`grid w-full grid-cols-[58px_76px_minmax(0,1fr)_70px] items-center gap-2 px-4 py-3 text-left text-xs transition ${i === playIdx ? 'bg-sky-50 ring-inset ring-1 ring-sky-200' : 'hover:bg-slate-50'}`}>
                <span className="font-mono font-black text-slate-500">{p.game_clock ?? `#${i + 1}`}</span>
                <span className="font-bold text-slate-700">{p.down} &amp; {p.to_go}</span>
                <span className="min-w-0"><b className="text-slate-900">{p.play_type.replaceAll('_', ' ')}</b><span className="ml-2 text-slate-500">{formatFieldPosition(p.yard_line)} · {(p.formation ?? (p.shotgun ? 'SHOTGUN' : 'UNDER CENTER')).toLowerCase()} · {p.personnel ?? '11'}</span></span>
                <span className={`text-right font-mono font-black ${p.turnover || p.yards < 0 ? 'text-rose-700' : p.yards >= 10 ? 'text-emerald-700' : 'text-slate-700'}`}>{p.turnover ?? `${p.yards > 0 ? '+' : ''}${p.yards} yd`}</span>
              </button>)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatFieldPosition(yard: number) {
  if (yard <= 0) return 'own goal line';
  if (yard < 50) return `own ${Math.round(yard)}`;
  if (yard === 50) return 'midfield';
  if (yard >= 100) return 'goal line';
  return `opponent ${100 - Math.round(yard)}`;
}

function resultTone(result: string) {
  const key = Object.keys(RESULT_TONE).find(value => result.startsWith(value));
  return key ? RESULT_TONE[key] : 'text-slate-600';
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-t border-slate-100 pt-1">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-medium tabular-nums text-slate-900">{v}</dd>
    </div>
  );
}
