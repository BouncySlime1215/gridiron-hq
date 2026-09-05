import { createContext, useContext, useEffect } from 'react';

/**
 * Lets a page register a small, cheap-to-produce summary of what it's
 * currently showing, for the floating "what am I looking at" assistant
 * mounted once at the App.tsx root layout (so it's present on every route in
 * the whole app, fantasy and betting alike). Kept intentionally separate from
 * App.tsx so pages that only need the hook don't have to import the root
 * component itself.
 */
export interface PageExplainInfo {
  section?: string | null;
  subview?: string | null;
  summary?: Record<string, unknown>;
  /**
   * Identifying info for whatever specific game/pick/market is currently in
   * view (e.g. `{ season, week, home_team }`), separate from `summary` —
   * this is what lets the assistant's backend tool-use loop target the right
   * record (nfl-page-explain.js's `game_projection_breakdown` tool etc.)
   * instead of guessing. Optional: most pages have nothing specific in view.
   */
  eventContext?: Record<string, unknown> | null;
}

export interface PageExplainContextValue {
  info: PageExplainInfo;
  setInfo: (info: PageExplainInfo) => void;
}

export const PageExplainContext = createContext<PageExplainContextValue | null>(null);

/**
 * Call from any page/subview rendered inside BettingWorkspace to tell the
 * floating assistant what's actually on screen. `summary` should be small
 * and honest — built from data the page already has in hand for its own
 * rendering, never the raw API payload (e.g. `{ open_picks: 3, more_favorable: 1,
 * gate_status: 'watching_no_action' }`, not the full Pick Watch response).
 *
 * Registers on mount/change and clears on unmount so a stale summary from a
 * page the user navigated away from is never shown for the next one.
 */
export function usePageExplain(
  section: string | null, subview: string | null, summary: Record<string, unknown>,
  eventContext: Record<string, unknown> | null = null
) {
  const ctx = useContext(PageExplainContext);
  const summaryKey = JSON.stringify(summary);
  const eventContextKey = JSON.stringify(eventContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setInfo({ section, subview, summary: JSON.parse(summaryKey), eventContext: JSON.parse(eventContextKey) });
    return () => ctx.setInfo({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, section, subview, summaryKey, eventContextKey]);
}
