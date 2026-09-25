import { createContext, useContext, useState, type CSSProperties } from 'react';

/**
 * WAR-ROOM-UI v2: a round player picture. ESPN headshots only (a.espncdn.com, from the
 * app's player list); lazy, fixed size (no layout shift), and initials on a coloured
 * circle when there is no picture or it fails to load. With no HeadshotContext provider
 * (the classic layout) it draws nothing, so the classic panels are unchanged.
 */
export const HeadshotContext = createContext<Record<string, string> | null>(null);

const ESPN = 'https://a.espncdn.com/';
const HUES = [210, 160, 25, 280, 340, 190, 45, 120];

export function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w));
  const a = words[0]?.[0] ?? '?';
  const b = words.length > 1 ? words[words.length - 1][0] : '';
  return `${a}${b}`.toUpperCase();
}

const hueOf = (s: string) => HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];

export default function Avatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const map = useContext(HeadshotContext);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!map) return null;
  const url = map[String(id)];
  const src = url && url.startsWith(ESPN) && url !== failedSrc ? url : null;
  return (
    <span className="wr-av" style={{ width: size, height: size, '--wr-av-h': String(hueOf(name)) } as CSSProperties} aria-hidden>
      {src
        ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
        : <span className="wr-av-i" style={{ fontSize: Math.round(size * 0.38) }}>{initials(name)}</span>}
    </span>
  );
}
