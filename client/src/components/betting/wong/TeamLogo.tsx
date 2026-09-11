import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useApi, type Team } from '../../../api';

/**
 * Team marks for the Wong board.
 *
 * There are no logo files on disk. `/api/teams` has the 32 rows with `abbr`,
 * `primary_color` and `secondary_color`, and ESPN's CDN serves a logo per
 * lowercased abbreviation — the same CDN and the same pattern this app
 * already uses for player headshots (`api.ts:headshotUrl`). All 32 of this
 * database's abbreviations were checked against that CDN and every one
 * answers 200, including the three that usually differ between sources
 * (WAS, LAR, JAX). The app serves no Content-Security-Policy, so nothing
 * blocks the request.
 *
 * A remote image can still fail — offline, a CDN hiccup, an unfamiliar team
 * string from a book feed — so every mark falls back to a badge built from
 * the team's own colours, and every mark carries a text alternative either
 * way. A logo is never allowed to render as a broken image.
 */

interface TeamIndex {
  byKey: Map<string, Team>;
  teams: Team[];
}

const TeamIndexContext = createContext<TeamIndex | null>(null);

const normalize = (value: string) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function buildIndex(teams: Team[]): TeamIndex {
  const byKey = new Map<string, Team>();
  const add = (key: string, team: Team) => { const k = normalize(key); if (k && !byKey.has(k)) byKey.set(k, team); };
  for (const team of teams) {
    add(team.name, team);
    add(team.abbr, team);
    const words = String(team.name ?? '').trim().split(/\s+/);
    // "Kansas City Chiefs" -> "chiefs" (unique across the league) and
    // "kansas city" (unique except for the two Los Angeles and two New York
    // clubs, which is why the city key is added last and never overwrites).
    if (words.length > 1) {
      add(words[words.length - 1], team);
      add(words.slice(0, -1).join(' '), team);
    }
  }
  return { byKey, teams };
}

function resolveTeam(index: TeamIndex | null, raw: string): Team | null {
  if (!index || !raw) return null;
  const key = normalize(raw);
  const direct = index.byKey.get(key);
  if (direct) return direct;
  // A book feed can hand over anything from "KC" to "Kansas City Chiefs" to
  // "Chiefs (KC)". Fall back to containment in either direction before giving
  // up and drawing a neutral badge.
  for (const [candidate, team] of index.byKey) {
    if (candidate.length >= 3 && (key.includes(candidate) || candidate.includes(key))) return team;
  }
  return null;
}

export function TeamIndexProvider({ children }: { children: React.ReactNode }) {
  // One request for the whole hub; `useApi` de-duplicates and caches by path.
  const { data } = useApi<Team[]>('/teams', { staleTime: 3_600_000 });
  const index = useMemo(() => buildIndex(Array.isArray(data) ? data : []), [data]);
  return <TeamIndexContext.Provider value={index}>{children}</TeamIndexContext.Provider>;
}

export function useTeam(raw: string) {
  const index = useContext(TeamIndexContext);
  return useMemo(() => resolveTeam(index, raw), [index, raw]);
}

export function logoUrl(abbr: string) {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr).toLowerCase()}.png`;
}

export function TeamLogo({ team: raw, size = 28, className = '' }: {
  team: string; size?: number; className?: string;
}) {
  const team = useTeam(raw);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [team?.abbr]);

  if (!team || failed) return <TeamBadge team={team} raw={raw} size={size} className={className} />;
  return <img
    src={logoUrl(team.abbr)}
    alt={`${team.name} logo`}
    width={size} height={size} loading="lazy" decoding="async"
    onError={() => setFailed(true)}
    style={{ width: size, height: size }}
    className={`shrink-0 object-contain ${className}`}
  />;
}

/** The fallback mark: the team's own two colours, never a broken image. */
function TeamBadge({ team, raw, size, className }: {
  team: Team | null; raw: string; size: number; className: string;
}) {
  const label = team?.name ?? raw ?? 'Unknown team';
  const text = (team?.abbr ?? String(raw ?? '?').replace(/[^A-Za-z]/g, '').slice(0, 3) ?? '?').toUpperCase();
  return <span
    role="img" aria-label={`${label} colours`} title={label}
    style={{
      width: size, height: size,
      background: team?.primary_color || '#0f172a',
      boxShadow: team?.secondary_color ? `inset 0 0 0 2px ${team.secondary_color}` : undefined,
      fontSize: Math.max(8, Math.round(size * 0.33))
    }}
    className={`grid shrink-0 place-items-center rounded-full font-black leading-none tracking-tight text-white ${className}`}
  >{text}</span>;
}

/** Logo + team name, the pairing used everywhere a leg or a side is named. */
export function TeamMark({ team: raw, size = 26, className = '', muted = false }: {
  team: string; size?: number; className?: string; muted?: boolean;
}) {
  const team = useTeam(raw);
  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
    <TeamLogo team={raw} size={size} />
    <span className={`truncate font-bold ${muted ? 'text-slate-600' : 'text-slate-900'}`}>{team?.name ?? raw}</span>
  </span>;
}
