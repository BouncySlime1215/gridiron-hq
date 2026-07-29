export interface SlotPlayer { name: string; player_id?: number | null; position?: string; jersey?: string | null }
type DepthMap = Record<string, SlotPlayer | undefined>;

export interface SlotGrade { score: number; grade: 'strength' | 'ok' | 'weakness'; reasons: string[]; starter: string; basis?: string }

interface Props {
  phase: 'offense' | 'defense' | 'special_teams';
  depth: DepthMap;
  depthMulti?: Record<string, SlotPlayer[]>;
  grades?: { slots?: Record<string, SlotGrade>; units?: Record<string, any> };
  showGrades?: boolean;
  accent?: string;
  onUnitClick?: (unit: string) => void;
  onPlayerClick?: (playerId: number) => void;
  selectedUnit?: string | null;
}

// Receivers may be split across sided slots or stacked in one.
const WR_SLOTS = ['LWR', 'RWR', 'SWR', 'WR'];

const lastName = (full: string) => {
  const parts = full.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : full;
};

/**
 * Resolve the Nth body across a set of slot codes. Teams differ: some list
 * LWR/RWR/SWR separately, others stack every receiver under one slot with ranks
 * 1-3, so we flatten the candidates and index into the combined pool.
 */
function pickSlot(depth: DepthMap, multi: Record<string, SlotPlayer[]> | undefined, codes: string[], index = 0): SlotPlayer | undefined {
  const pool: SlotPlayer[] = [];
  const seen = new Set<string>();
  for (const c of codes) {
    const group = multi?.[c] ?? (depth[c] ? [depth[c]!] : []);
    for (const p of group) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      pool.push(p);
    }
  }
  return pool[index];
}

const GRADE_COLOR = { strength: '#10b981', weakness: '#f43f5e', ok: '#cbd5e1' } as const;

function Node({ x, y, type, code, player, accent, onClick, grade }: {
  x: number; y: number; type: 'O' | 'X'; code: string; player?: SlotPlayer;
  accent: string; onClick?: (id: number) => void; grade?: SlotGrade;
}) {
  const clickable = !!(onClick && player?.player_id);
  const halo = grade && grade.grade !== 'ok' ? GRADE_COLOR[grade.grade] : null;
  return (
    <g onClick={clickable ? () => onClick!(player!.player_id!) : undefined}
      style={{ cursor: clickable ? 'pointer' : 'default' }}>
      {halo && (
        <circle cx={x} cy={y} r={21} fill={halo} fillOpacity={0.13} stroke={halo} strokeOpacity={0.5} strokeWidth={1.5}>
          {grade!.grade === 'weakness' && (
            <animate attributeName="r" values="20;23;20" dur="2.4s" repeatCount="indefinite" />
          )}
        </circle>
      )}
      {grade && grade.grade !== 'ok' && (
        <title>{`${grade.starter} — ${grade.grade.toUpperCase()}: ${grade.reasons.join(', ')}`}</title>
      )}
      {type === 'O' ? (
        <circle cx={x} cy={y} r={14} fill={player ? accent : '#fff'} fillOpacity={player ? 0.14 : 1}
          stroke={player ? accent : '#cbd5e1'} strokeWidth={2} />
      ) : (
        <g stroke={player ? accent : '#cbd5e1'} strokeWidth={3.5} strokeLinecap="round">
          <line x1={x - 9} y1={y - 9} x2={x + 9} y2={y + 9} />
          <line x1={x - 9} y1={y + 9} x2={x + 9} y2={y - 9} />
        </g>
      )}
      <text x={x} y={type === 'O' ? y + 4 : y - 14} textAnchor="middle" fontSize={8.5} fontWeight={800}
        fill={player ? accent : '#94a3b8'}>{code}</text>
      <text x={x} y={y + 28} textAnchor="middle" fontSize={11} fontWeight={700}
        fill={player ? '#0f172a' : '#cbd5e1'}
        textDecoration={clickable ? 'underline' : 'none'}>
        {player ? lastName(player.name) : '—'}
      </text>
    </g>
  );
}

function UnitBox({ x, y, w, h, label, onClick, selected }: {
  x: number; y: number; w: number; h: number; label: string; onClick?: () => void; selected?: boolean;
}) {
  return (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <rect x={x} y={y} width={w} height={h} rx={10}
        fill={selected ? 'rgba(16,185,129,0.08)' : '#f8fafc'}
        stroke={selected ? '#10b981' : '#e2e8f0'} strokeWidth={selected ? 2 : 1.25}
        strokeDasharray={selected ? '' : '5 4'} />
      <text x={x + w / 2} y={y - 6} textAnchor="middle" fontSize={9} fontWeight={800}
        fill={selected ? '#059669' : '#94a3b8'} letterSpacing={1.2}>
        {label}{onClick ? '  ⓘ' : ''}
      </text>
    </g>
  );
}

export default function FormationView({
  phase, depth, depthMulti, grades, showGrades = true, accent = '#0f766e', onUnitClick, onPlayerClick, selectedUnit
}: Props) {
  const p = (codes: string[], i = 0) => pickSlot(depth, depthMulti, codes, i);
  const g = (code: string) => (showGrades ? grades?.slots?.[code] : undefined);
  // 3-4 fronts list a nose tackle and outside backers; 4-3 fronts list two DTs.
  const is34 = !!(depth.NT || depth.LOLB || depth.ROLB);

  return (
    <svg viewBox="0 0 800 430" className="w-full rounded-xl border border-slate-200 bg-white">
      <line x1={40} y1={phase === 'offense' ? 244 : 300} x2={760} y2={phase === 'offense' ? 244 : 300}
        stroke="#e2e8f0" strokeWidth={2} strokeDasharray="10 6" />
      <text x={762} y={(phase === 'offense' ? 244 : 300) - 7} textAnchor="end" fontSize={8}
        fill="#cbd5e1" fontWeight={700} letterSpacing={1}>LINE OF SCRIMMAGE</text>

      {phase === 'offense' && (
        <>
          <UnitBox x={258} y={258} w={284} h={56} label="OFFENSIVE LINE"
            onClick={onUnitClick ? () => onUnitClick('OL') : undefined} selected={selectedUnit === 'OL'} />
          {(['LT', 'LG', 'C', 'RG', 'RT'] as const).map((code, i) => (
            <Node key={code} x={290 + i * 55} y={286} type="O" code={code}
              player={p([code])} grade={g(code)} accent={accent} onClick={onPlayerClick} />
          ))}
          <Node x={92} y={286} type="O" code="WR" player={p(WR_SLOTS, 0)} grade={g('LWR') ?? g('WR')} accent={accent} onClick={onPlayerClick} />
          <Node x={182} y={310} type="O" code="SLOT" player={p(WR_SLOTS, 2)} grade={g('SWR')} accent={accent} onClick={onPlayerClick} />
          <Node x={706} y={310} type="O" code="WR" player={p(WR_SLOTS, 1)} grade={g('RWR')} accent={accent} onClick={onPlayerClick} />
          <Node x={588} y={286} type="O" code="TE" player={p(['TE'])} grade={g('TE')} accent={accent} onClick={onPlayerClick} />
          <Node x={400} y={372} type="O" code="QB" player={p(['QB'])} grade={g('QB')} accent={accent} onClick={onPlayerClick} />
          <Node x={316} y={372} type="O" code="RB" player={p(['RB'])} grade={g('RB')} accent={accent} onClick={onPlayerClick} />
        </>
      )}

      {phase === 'defense' && (
        <>
          <UnitBox x={214} y={232} w={372} h={54} label={is34 ? 'FRONT THREE (3-4)' : 'DEFENSIVE LINE (4-3)'}
            onClick={onUnitClick ? () => onUnitClick('DL') : undefined} selected={selectedUnit === 'DL'} />
          {is34 ? (
            <>
              <Node x={290} y={260} type="X" code="DE" player={p(['LDE'])} grade={g('LDE')} accent={accent} onClick={onPlayerClick} />
              <Node x={400} y={260} type="X" code="NT" player={p(['NT'])} grade={g('NT')} accent={accent} onClick={onPlayerClick} />
              <Node x={510} y={260} type="X" code="DE" player={p(['RDE'])} grade={g('RDE')} accent={accent} onClick={onPlayerClick} />
              <Node x={150} y={214} type="X" code="OLB" player={p(['LOLB'])} grade={g('LOLB')} accent={accent} onClick={onPlayerClick} />
              <Node x={650} y={214} type="X" code="OLB" player={p(['ROLB'])} grade={g('ROLB')} accent={accent} onClick={onPlayerClick} />
            </>
          ) : (
            <>
              <Node x={262} y={260} type="X" code="DE" player={p(['LDE'])} grade={g('LDE')} accent={accent} onClick={onPlayerClick} />
              <Node x={356} y={260} type="X" code="DT" player={p(['LDT', 'NT'])} grade={g('LDT') ?? g('NT')} accent={accent} onClick={onPlayerClick} />
              <Node x={444} y={260} type="X" code="DT" player={p(['RDT'])} grade={g('RDT')} accent={accent} onClick={onPlayerClick} />
              <Node x={538} y={260} type="X" code="DE" player={p(['RDE'])} grade={g('RDE')} accent={accent} onClick={onPlayerClick} />
            </>
          )}

          <UnitBox x={272} y={140} w={256} h={52} label="LINEBACKERS"
            onClick={onUnitClick ? () => onUnitClick('LB') : undefined} selected={selectedUnit === 'LB'} />
          {is34 ? (
            <>
              <Node x={340} y={166} type="X" code="ILB" player={p(['LILB', 'MLB'])} grade={g('LILB') ?? g('MLB')} accent={accent} onClick={onPlayerClick} />
              <Node x={460} y={166} type="X" code="ILB" player={p(['RILB'])} grade={g('RILB')} accent={accent} onClick={onPlayerClick} />
            </>
          ) : (
            <>
              <Node x={300} y={166} type="X" code="WLB" player={p(['WLB'])} grade={g('WLB')} accent={accent} onClick={onPlayerClick} />
              <Node x={400} y={166} type="X" code="MLB" player={p(['MLB'])} grade={g('MLB')} accent={accent} onClick={onPlayerClick} />
              <Node x={500} y={166} type="X" code="SLB" player={p(['SLB'])} grade={g('SLB')} accent={accent} onClick={onPlayerClick} />
            </>
          )}

          <UnitBox x={64} y={30} w={672} h={52} label="SECONDARY"
            onClick={onUnitClick ? () => onUnitClick('DB') : undefined} selected={selectedUnit === 'DB'} />
          <Node x={110} y={166} type="X" code="CB" player={p(['LCB'])} grade={g('LCB')} accent={accent} onClick={onPlayerClick} />
          <Node x={690} y={166} type="X" code="CB" player={p(['RCB'])} grade={g('RCB')} accent={accent} onClick={onPlayerClick} />
          <Node x={214} y={112} type="X" code="NB" player={p(['NB'])} grade={g('NB')} accent={accent} onClick={onPlayerClick} />
          <Node x={330} y={56} type="X" code="FS" player={p(['FS'])} grade={g('FS')} accent={accent} onClick={onPlayerClick} />
          <Node x={470} y={56} type="X" code="SS" player={p(['SS'])} grade={g('SS')} accent={accent} onClick={onPlayerClick} />
        </>
      )}

      {phase === 'special_teams' && (
        <>
          <UnitBox x={150} y={258} w={500} h={56} label="COVERAGE / PROTECTION"
            onClick={onUnitClick ? () => onUnitClick('ST') : undefined} selected={selectedUnit === 'ST'} />
          {Array.from({ length: 9 }, (_, i) => (
            <Node key={i} x={190 + i * 52.5} y={286} type="X" code="" accent={accent} />
          ))}
          <Node x={330} y={372} type="O" code="K" player={p(['K', 'PK'])} accent={accent} onClick={onPlayerClick} />
          <Node x={470} y={372} type="O" code="P" player={p(['P'])} grade={g('P')} accent={accent} onClick={onPlayerClick} />
          <Node x={400} y={330} type="O" code="LS" player={p(['LS'])} grade={g('LS')} accent={accent} onClick={onPlayerClick} />
          <Node x={330} y={64} type="O" code="KR" player={p(['KR'])} grade={g('KR')} accent={accent} onClick={onPlayerClick} />
          <Node x={470} y={64} type="O" code="PR" player={p(['PR'])} grade={g('PR')} accent={accent} onClick={onPlayerClick} />
        </>
      )}
    </svg>
  );
}
