/**
 * "Market as of" for the FantasyCalc price behind every trade value on Trade Lab
 * (FC-SNAP). Reads `market_as_of` from GET /api/trades/:leagueId/rosters, which comes
 * from server/services/dynasty-value-history.js#marketAsOf. The link back to
 * FantasyCalc.com is the visible attribution FantasyCalc's terms ask for wherever its
 * data appears.
 */
export interface MarketAsOfInfo {
  format_key: string;
  fetched_at: string | null;
  age_hours: number | null;
  state: 'fresh' | 'stale' | 'empty' | 'table_absent';
  source_url: string;
  stale_after_hours?: number;
}

/** 'YYYY-MM-DD HH:MM:SS' is UTC (SQLite datetime('now')). */
function asDate(s: string): Date | null {
  const d = new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ageText(hours: number): string {
  if (hours < 1) return 'under an hour old';
  if (hours < 48) return `${Math.round(hours)} hours old`;
  return `${Math.floor(hours / 24)} days old`;
}

export default function MarketAsOf({ asOf }: { asOf?: MarketAsOfInfo | null }) {
  if (!asOf) return null;
  const link = (
    <a href={asOf.source_url} target="_blank" rel="noreferrer"
       className="underline decoration-slate-300 underline-offset-2 hover:text-slate-700">FantasyCalc.com</a>
  );
  const at = asOf.fetched_at ? asDate(asOf.fetched_at) : null;
  if (!at || asOf.age_hours == null) {
    return (
      <p className="text-xs text-slate-500">
        Trade values from {link} have not been fetched for this league's format yet, so every market value reads 0.
      </p>
    );
  }
  const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const stale = asOf.state === 'stale';
  return (
    <p className={`text-xs ${stale ? 'text-amber-700' : 'text-slate-500'}`}>
      Market as of {day} ({ageText(asOf.age_hours)}), trade values from {link}.
      {stale && ' Older than a day: prices may have moved since.'}
    </p>
  );
}
