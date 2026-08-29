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
}
interface Drive {
  half: number | string; possession: string; start_yard: number; points: number;
  result: string; plays: number; seconds: number; tape: Play[];
}
interface DriveSet {
  home: string; away: string; drives_with_plays: number; drives: Drive[];
  note: string; error?: string;
}

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
  'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];

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

export default function FieldSim() {
  const [home, setHome] = useState('KC');
  const [away, setAway] = useState('BUF');
  const [seed, setSeed] = useState(7);
  const [driveIdx, setDriveIdx] = useState(0);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);   // 0..1 through the current play
  const raf = useRef<number | null>(null);

  const { data, loading } = useApi<DriveSet>(
    `/nfl-betting/sim/drive?home=${home}&away=${away}&seed=${seed}`);

  const drives = data?.drives ?? [];
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
        <h2 className="font-semibold text-slate-900">Drive board</h2>
        <p className="mt-1 text-sm text-slate-600">
          The play simulator resolves every snap individually — down, distance, field position, play
          type, yardage, formation — and that tape was previously discarded once the drive was scored.
          This draws it. Formations come from nflverse participation data — 36,959 charted plays where
          the league lined up in shotgun 68.9% of the time, under centre 27.2% and pistol 3.9%, drawing
          5.96 and 7.0 defenders into the box respectively. Personnel groupings and box counts are real,
          so this is a diagram rather than a drawing.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-500">Home
            <select value={home} onChange={e => setHome(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {TEAMS.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Away
            <select value={away} onChange={e => setAway(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {TEAMS.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Drive
            <select value={driveIdx} onChange={e => setDriveIdx(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {drives.map((d, i) => (
                <option key={i} value={i}>
                  {i + 1}. {d.possession === 'home' ? home : away} — {d.result}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setSeed(Math.floor(Math.random() * 1e6))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            New game
          </button>
          <button onClick={() => { setPlaying(p => !p); }} disabled={!tape.length}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
            {playing ? 'Pause' : 'Play drive'}
          </button>
        </div>
      </div>

      {loading && !data && <div className="card p-6 text-sm text-slate-500">Simulating a game…</div>}
      {data?.error && <div className="card p-6 text-sm text-rose-700">{data.error}</div>}

      {drive && (
        <>
          <div className="card overflow-x-auto p-3">
            <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block" style={{ maxHeight: 620 }}
              role="img" aria-label="Simulated football play">
              <rect x={0} y={0} width={W} height={H} fill="#14532d" />
              {/* End zones: the one being attacked is at the top. */}
              <rect x={0} y={0} width={W} height={EZ} fill="#166534" />
              <rect x={0} y={H - EZ} width={W} height={EZ} fill="#166534" />

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
                  Drive {driveIdx + 1} · {drive.possession === 'home' ? home : away}
                </h3>
                <span className={`text-sm font-semibold ${RESULT_TONE[drive.result.split(' ')[0]] ?? 'text-slate-600'}`}>
                  {drive.result} {drive.points > 0 && `(${drive.points})`}
                </span>
              </div>
              {play && (
                <p className="mt-2 font-mono text-sm text-slate-800">
                  {play.down} &amp; {play.to_go} at the {play.yard_line <= 50 ? play.yard_line : 100 - play.yard_line}
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
                <Row k="Started" v={`own ${drive.start_yard}`} />
                <Row k="Plays" v={String(drive.plays)} />
                <Row k="Elapsed" v={`${Math.floor(drive.seconds / 60)}:${String(drive.seconds % 60).padStart(2, '0')}`} />
                <Row k="Result" v={drive.result} />
              </dl>
              <p className="mt-3 text-xs text-slate-500">{data?.note}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-t border-slate-100 pt-1">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-medium tabular-nums text-slate-900">{v}</dd>
    </div>
  );
}
