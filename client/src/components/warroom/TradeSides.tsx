import { useState, type CSSProperties } from 'react';
import Icon from './icons';

/**
 * TradeSides (docs/ui/CONSOLIDATION-MAP.md section 6: "one give/get block"): what you give and what
 * you get, drawn the same way on the planner's hero card (Today, Trades → Next move) and on the
 * finder's trade card (Find deals, Build, Go get → someone else). A photo (ESPN headshot, initials
 * when there is none), the name and the position; the get side is tinted. `size` 'big' is the hero,
 * 'compact' a list card. A player chip opens his card when `onOpen` is given.
 */
export interface SidePlayer { id: string | number; name: string; pos?: string | null; team?: string | null; headshot?: string | null; title?: string }

const HUES = [230, 160, 25, 280, 340, 190, 45, 120];
const hueOf = (s: string) => HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
const initials = (name: string) => {
  const w = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return `${w[0]?.[0] ?? '?'}${w.length > 1 ? w[w.length - 1][0] : ''}`.toUpperCase();
};

function Face({ p, size }: { p: SidePlayer; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = p.headshot && !failed ? p.headshot : null;
  return (
    <span className="wr-av" style={{ width: size, height: size, '--wr-av-h': String(hueOf(p.name)) } as CSSProperties} aria-hidden>
      {src ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <span className="wr-av-i" style={{ fontSize: Math.round(size * 0.38) }}>{initials(p.name)}</span>}
    </span>
  );
}

function Side({ label, players, side, size, onOpen }: { label: string; players: SidePlayer[]; side: 'give' | 'get'; size: 'big' | 'compact'; onOpen?: (p: SidePlayer) => void }) {
  const px = size === 'big' ? 44 : 28;
  return (
    <div className="wr-hero-side trade-side" data-side={side}>
      <div className="wr-k trade-side-k">{label}</div>
      <div className="wr-pchips">
        {players.map(p => {
          const inner = <>
            <Face p={p} size={px} />
            <span className="wr-pchip-n">{p.name}</span>
            {(p.pos || p.team) && <span className="wr-pchip-p">{[p.pos, size === 'compact' ? p.team : null].filter(Boolean).join(' · ')}</span>}
          </>;
          return onOpen
            ? <button key={p.id} type="button" className="wr-pchip" data-player={String(p.id)} title={p.title ?? `Open ${p.name}`} onClick={() => onOpen(p)}>{inner}</button>
            : <span key={p.id} className="wr-pchip" data-player={String(p.id)} title={p.title ?? p.name}>{inner}</span>;
        })}
        {!players.length && <span className="wr-muted">nothing</span>}
      </div>
    </div>
  );
}

export default function TradeSides({ give, get, size = 'big', onOpen, giveLabel = 'You give', getLabel = 'You get' }: {
  give: SidePlayer[]; get: SidePlayer[]; size?: 'big' | 'compact'; onOpen?: (p: SidePlayer) => void; giveLabel?: string; getLabel?: string;
}) {
  return (
    <div className={`wr-hero-deal trade-sides trade-sides-${size}`} data-testid="trade-sides">
      <Side label={giveLabel} players={give} side="give" size={size} onOpen={onOpen} />
      <span className="wr-hero-arrow" aria-hidden><Icon name="arrow" size={size === 'big' ? 20 : 16} /></span>
      <Side label={getLabel} players={get} side="get" size={size} onOpen={onOpen} />
    </div>
  );
}
