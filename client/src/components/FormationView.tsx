export interface SlotPlayer { name: string; id?: number }
type SlotValue = string | SlotPlayer | null | undefined;

interface Props {
  phase: 'offense' | 'defense' | 'special_teams';
  slots: Record<string, SlotValue>;
  scheme?: string;
  accent?: string;
  onUnitClick?: (unit: string) => void;
  onPlayerClick?: (playerId: number) => void;
  selectedUnit?: string | null;
}

function norm(v: SlotValue): SlotPlayer | null {
  if (!v) return null;
  return typeof v === 'string' ? { name: v } : v;
}

function lastName(full: string) {
  const parts = full.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : full;
}

function Node({ x, y, type, code, player, accent, onClick }: {
  x: number; y: number; type: 'O' | 'X'; code: string; player?: SlotPlayer | null;
  accent: string; onClick?: () => void;
}) {
  const clickable = !!(onClick && player?.id);
  return (
    <g onClick={clickable ? onClick : undefined} style={{ cursor: clickable ? 'pointer' : 'default' }}>
      {type === 'O' ? (
        <circle cx={x} cy={y} r={15} fill={player ? accent : '#fff'} fillOpacity={player ? 0.12 : 1}
          stroke={player ? accent : '#94a3b8'} strokeWidth={2} />
      ) : (
        <g stroke={player ? accent : '#94a3b8'} strokeWidth={3.5} strokeLinecap="round">
          <line x1={x - 9} y1={y - 9} x2={x + 9} y2={y + 9} />
          <line x1={x - 9} y1={y + 9} x2={x + 9} y2={y - 9} />
        </g>
      )}
      <text x={x} y={y + (type === 'O' ? 4 : -14)} textAnchor="middle" fontSize={9} fontWeight={700}
        fill={type === 'O' ? (player ? accent : '#64748b') : '#64748b'}>
        {type === 'O' ? code : code}
      </text>
      {player && (
        <text x={x} y={y + 30} textAnchor="middle" fontSize={11.5} fontWeight={700}
          fill="#0f172a" textDecoration={clickable ? 'underline' : 'none'}>
          {lastName(player.name)}
        </text>
      )}
    </g>
  );
}

function UnitBlock({ x, y, w, h, label, onClick, selected }: {
  x: number; y: number; w: number; h: number; label: string;
  onClick?: () => void; selected?: boolean;
}) {
  return (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <rect x={x} y={y} width={w} height={h} rx={10}
        fill={selected ? 'rgba(16,185,129,0.10)' : '#f8fafc'}
        stroke={selected ? '#10b981' : '#cbd5e1'} strokeWidth={selected ? 2 : 1.25}
        strokeDasharray={selected ? '' : '5 4'} />
      <text x={x + w / 2} y={y - 7} textAnchor="middle" fontSize={10} fontWeight={800}
        fill={selected ? '#059669' : '#64748b'} letterSpacing={1.5}>
        {label}{onClick ? '  ⓘ' : ''}
      </text>
    </g>
  );
}

export default function FormationView({ phase, slots, scheme = '', accent = '#0f766e', onUnitClick, onPlayerClick, selectedUnit }: Props) {
  const is34 = /3-4/.test(scheme);
  const p = (code: string) => norm(slots[code]);
  const click = (code: string) => {
    const pl = p(code);
    return pl?.id && onPlayerClick ? () => onPlayerClick(pl.id!) : undefined;
  };

  return (
    <svg viewBox="0 0 800 440" className="w-full rounded-xl border border-slate-200 bg-white">
      {/* line of scrimmage */}
      <line x1={40} y1={phase === 'offense' ? 250 : 310} x2={760} y2={phase === 'offense' ? 250 : 310}
        stroke="#e2e8f0" strokeWidth={2} strokeDasharray="10 6" />
      <text x={760} y={(phase === 'offense' ? 250 : 310) - 8} textAnchor="end" fontSize={9} fill="#cbd5e1" fontWeight={700} letterSpacing={1}>LOS</text>

      {phase === 'offense' && (
        <>
          <UnitBlock x={255} y={262} w={290} h={58} label="O-LINE UNIT"
            onClick={onUnitClick ? () => onUnitClick('OL') : undefined} selected={selectedUnit === 'OL'} />
          {['LT', 'LG', 'C', 'RG', 'RT'].map((c, i) => (
            <Node key={c} x={290 + i * 55} y={291} type="O" code={c} accent={accent} />
          ))}
          <Node x={95} y={291} type="O" code="X" player={p('WR1')} accent={accent} onClick={click('WR1')} />
          <Node x={185} y={310} type="O" code="SLOT" player={p('WR3')} accent={accent} onClick={click('WR3')} />
          <Node x={705} y={310} type="O" code="Z" player={p('WR2')} accent={accent} onClick={click('WR2')} />
          <Node x={590} y={291} type="O" code="TE" player={p('TE1')} accent={accent} onClick={click('TE1')} />
          <Node x={400} y={382} type="O" code="QB" player={p('QB')} accent={accent} onClick={click('QB')} />
          <Node x={318} y={382} type="O" code="RB" player={p('RB1')} accent={accent} onClick={click('RB1')} />
        </>
      )}

      {phase === 'defense' && (
        <>
          <UnitBlock x={230} y={238} w={340} h={58} label={is34 ? 'FRONT — 3-4' : 'D-LINE UNIT — 4-3'}
            onClick={onUnitClick ? () => onUnitClick('DL') : undefined} selected={selectedUnit === 'DL'} />
          {is34 ? (
            <>
              <Node x={310} y={268} type="X" code="DE" accent={accent} />
              <Node x={400} y={268} type="X" code="NT" player={p('DL')} accent={accent} onClick={click('DL')} />
              <Node x={490} y={268} type="X" code="DE" accent={accent} />
              <Node x={200} y={268} type="X" code="EDGE" player={p('EDGE')} accent={accent} onClick={click('EDGE')} />
              <Node x={600} y={268} type="X" code="EDGE" accent={accent} />
            </>
          ) : (
            <>
              <Node x={275} y={268} type="X" code="EDGE" player={p('EDGE')} accent={accent} onClick={click('EDGE')} />
              <Node x={365} y={268} type="X" code="DT" player={p('DL')} accent={accent} onClick={click('DL')} />
              <Node x={445} y={268} type="X" code="DT" accent={accent} />
              <Node x={530} y={268} type="X" code="EDGE" accent={accent} />
            </>
          )}
          <UnitBlock x={285} y={148} w={230} h={54} label="LINEBACKERS"
            onClick={onUnitClick ? () => onUnitClick('LB') : undefined} selected={selectedUnit === 'LB'} />
          <Node x={345} y={176} type="X" code={is34 ? 'ILB' : 'WILL'} accent={accent} />
          <Node x={455} y={176} type="X" code={is34 ? 'ILB' : 'MIKE'} player={p('LB')} accent={accent} onClick={click('LB')} />
          <UnitBlock x={70} y={36} w={660} h={56} label="SECONDARY"
            onClick={onUnitClick ? () => onUnitClick('DB') : undefined} selected={selectedUnit === 'DB'} />
          <Node x={120} y={176} type="X" code="CB1" player={p('CB')} accent={accent} onClick={click('CB')} />
          <Node x={680} y={176} type="X" code="CB2" accent={accent} />
          <Node x={290} y={64} type="X" code="FS" player={p('S')} accent={accent} onClick={click('S')} />
          <Node x={510} y={64} type="X" code="SS" accent={accent} />
        </>
      )}

      {phase === 'special_teams' && (
        <>
          <UnitBlock x={150} y={262} w={500} h={58} label="COVERAGE / PROTECTION UNIT"
            onClick={onUnitClick ? () => onUnitClick('ST') : undefined} selected={selectedUnit === 'ST'} />
          {Array.from({ length: 9 }, (_, i) => (
            <Node key={i} x={190 + i * 52.5} y={291} type="X" code="" accent={accent} />
          ))}
          <Node x={400} y={390} type="O" code="K" player={p('K')} accent={accent} onClick={click('K')} />
          <Node x={400} y={70} type="O" code="RET" accent={accent} />
          <text x={400} y={104} textAnchor="middle" fontSize={10} fill="#94a3b8">returner</text>
        </>
      )}
    </svg>
  );
}
