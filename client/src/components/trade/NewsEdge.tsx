import { useState } from 'react';
import { useApi } from '../../api';
import { PageError, PageLoading, EmptyState } from '../PageState';
import { Card, Chip } from '../ui/DesignSystem';
import RulesHidden from './RulesHidden';
import { FIRST, oneCardPerMove } from './newsEdgeCards';

/**
 * Trades → News edge: news the league has not priced in yet, turned into a move (news-lag-trader.js).
 * The tradeable player is usually the one who inherits the snaps, not the one in the headline. Every
 * idea has passed Nick's rule gate on the server (gateNewsEdge); the count it hid shows under the list.
 */
type Kind = 'claim_waiver' | 'buy_beneficiary' | 'buy_low' | 'hold_or_sell' | 'already_held';
const KIND: Record<Kind, { label: string; tone: 'good' | 'accent' | 'warn' | 'neutral' }> = {
  claim_waiver: { label: 'Waiver add', tone: 'good' },
  buy_beneficiary: { label: 'Buy the backup', tone: 'good' },
  buy_low: { label: 'Buy low', tone: 'accent' },
  hold_or_sell: { label: 'Hold or sell', tone: 'warn' },
  already_held: { label: 'You have him', tone: 'neutral' },
};
const WINDOWS = [24, 72, 168, 336] as const;

interface Opportunity {
  subject: { name: string; status: string; owned_by: string };
  action: { kind: Kind; target?: string; target_position?: string; target_owned_by?: string; why: string };
  age_hours: number; confidence: number | string; evidence: string; source: string;
}
interface NewsEdgeData {
  error?: string; signals_considered?: number; opportunities?: Opportunity[]; note?: string; dropped_by_rule?: number;
}

export const ageText = (h: number) => (h < 48 ? `${Math.round(h)} h ago` : `${(h / 24).toFixed(1)} d ago`);

export default function NewsEdge({ leagueId, teamId }: { leagueId: number; teamId: string | null }) {
  const [hours, setHours] = useState<number>(168);
  const [all, setAll] = useState(false);
  const { data, loading, error, refetch } = useApi<NewsEdgeData>(`/trades/${leagueId}/news-edge?hours=${hours}${teamId ? `&team_id=${teamId}` : ''}`);
  // No team picked: the server frames it from the league's own team (leagues.my_team_id).
  const windows = (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="How far back">
      {WINDOWS.map(h => <Chip key={h} on={hours === h} onClick={() => setHours(h)}>{h < 48 ? `${h} h` : `${h / 24} days`}</Chip>)}
    </div>
  );
  const head = (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3" data-testid="news-edge-head">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">Your league has not read this yet</h2>
        <p className="ds-note">{data?.signals_considered ?? 0} checked news items. The move is usually the player who inherits the snaps.</p>
      </div>
      {windows}
    </div>
  );
  if (loading && !data) return <>{head}<PageLoading label="Reading the wire…" /></>;
  if (error && !data) return <>{head}<PageError message={error} onRetry={refetch} /></>;
  if (data?.error) return <>{head}<EmptyState title="No news edge for this league yet" description={data.error} /></>;
  const opps = oneCardPerMove(data?.opportunities ?? []);
  const shown = all ? opps : opps.slice(0, FIRST);
  return (
    <div data-testid="news-edge">
      {head}
      {!opps.length
        ? <EmptyState title="Nothing to act on in this window" description="Either the wire is quiet, or every idea it had was already yours or hidden by your rules." />
        : <div className="space-y-3">
          {shown.map((o, i) => {
            const k = KIND[o.action.kind] ?? { label: o.action.kind, tone: 'neutral' as const };
            return (
              <Card key={`${o.subject.name}-${o.action.kind}-${i}`} className="!p-4" as="article">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={k.tone}>{k.label}</Chip>
                  {o.action.target && <span className="min-w-0 break-words text-base font-semibold">{o.action.target}</span>}
                  {o.action.target_position && <span className="ds-note">{o.action.target_position}</span>}
                  {o.action.kind === 'claim_waiver' && <span className="ds-note" data-testid="not-a-trade">not a trade: a lineup add off the wire</span>}
                  <span className="ds-note ml-auto tabular-nums">{ageText(o.age_hours)}</span>
                </div>
                <p className="mt-2 text-sm">{o.action.why}</p>
                <p className="ds-note mt-2 break-words">
                  <b className="text-[var(--c-ink)]">{o.subject.name}</b> · {String(o.subject.status).replace(/_/g, ' ')} · held by {o.subject.owned_by}
                  {o.action.target_owned_by && o.action.target_owned_by !== o.subject.owned_by && <> · target held by {o.action.target_owned_by}</>}
                </p>
                <p className="ds-note mt-1 break-words italic">“{o.evidence}” <span className="not-italic">· {o.source} · confidence {o.confidence}
                  {o.more_reports > 0 && ` · ${o.more_reports} more report${o.more_reports === 1 ? '' : 's'} say the same`}</span></p>
              </Card>
            );
          })}
          {opps.length > FIRST && (
            <button type="button" className="ds-btn ds-btn-quiet w-full" aria-expanded={all} onClick={() => setAll(v => !v)}>
              {all ? 'Show the freshest 5' : `Show all ${opps.length} moves`}
            </button>
          )}
        </div>}
      <RulesHidden n={data?.dropped_by_rule} className="mt-3" />
      {data?.note && <p className="ds-note mt-3">{data.note}</p>}
    </div>
  );
}
