import { useApi } from '../../api';

/**
 * PULSE-01 chat pulse ticker (WAR-ROOM-UI.md: "chat pulse ticker (new labelled statements,
 * no quotes: 'in-market for WR · 2h')").
 *
 * Reads GET /trades/:leagueId/people/pulse. Labels only: the server never sends a quote, and
 * this strip never asks for one. Off by default (GRIDIRON_PULSE_ENABLED or preview mode):
 * when the server says `enabled: false` the strip renders nothing, so a switched-off feature
 * never reads as "nobody is talking". A credible statement (its follow-through clears the
 * bar) is marked, because that is the one that replans the War Room.
 */
type PulseItem = {
  id: number;
  roster_id: number;
  team_name: string | null;
  type: string;
  phrase: string;
  credible: boolean;
  weight: number | null;
  ago: string;
};
type PulseResponse = {
  enabled: boolean;
  reason?: string;
  status?: 'ok' | 'table_absent';
  items: PulseItem[];
  last_run?: { ran_at: string; replan_status: string | null } | null;
};

export default function PulseTicker({ leagueId }: { leagueId: number | string }) {
  const pulse = useApi<PulseResponse>(`/trades/${leagueId}/people/pulse`, { staleTime: 60_000 });
  const data = pulse.data;
  if (pulse.error) {
    return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">Chat pulse unavailable: {pulse.error}</div>;
  }
  if (!data || !data.enabled) return null;
  if (data.status === 'table_absent') {
    return <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Chat pulse is on but has not run yet (migration 098 not applied).</div>;
  }
  return (
    <div className="flex items-center gap-3 overflow-x-auto rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
      aria-label="Chat pulse: league-mates' recent statements, labels only">
      <span className="shrink-0 text-[10px] font-black uppercase tracking-[.14em] text-emerald-700">Chat pulse</span>
      {data.items.length === 0 && (
        <span className="text-slate-500">No labelled statements in the last 72 h.</span>
      )}
      {data.items.map(item => (
        <span key={item.id} className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 ${
          item.credible ? 'bg-emerald-50 font-semibold text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
          title={item.credible ? `Credible: follow-through ${item.weight ?? '?'}x base, replans the War Room` : 'Label only; no proven follow-through'}>
          {item.team_name ?? `Team ${item.roster_id}`}: {item.phrase} · {item.ago}
        </span>
      ))}
    </div>
  );
}
