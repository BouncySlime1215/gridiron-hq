import { createContext, useContext, useEffect, useRef } from 'react';

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
  // The context object is deliberately NOT an effect dependency, and reaching
  // it through a ref is what makes that safe rather than stale.
  //
  // The provider builds a fresh `{ info, setInfo }` on every render, so its
  // identity changes every time `info` is set. With `ctx` in the dependency
  // array that is a guaranteed infinite loop: the effect calls setInfo, the
  // provider re-renders with a new object, the dependency compares unequal,
  // the cleanup fires `setInfo({})`, the provider re-renders again, and React
  // eventually bails out with "Maximum update depth exceeded". Worse than the
  // wasted renders, the registered summary spent half of them as `{}` — the
  // floating assistant could be asked what the page shows at exactly the
  // moment the answer had been cleared.
  //
  // Only `setInfo` is ever used here and it is a useState setter, which React
  // guarantees is stable for the life of the component, so the ref can never
  // hand back a setter that writes to the wrong provider. What genuinely
  // should re-register is the page's own identity and payload, and those are
  // the remaining dependencies (the payloads serialized, so a fresh object
  // literal with unchanged contents does not count as a change).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const current = ctxRef.current;
    if (!current) return;
    current.setInfo({ section, subview, summary: JSON.parse(summaryKey), eventContext: JSON.parse(eventContextKey) });
    return () => ctxRef.current?.setInfo({});
  }, [section, subview, summaryKey, eventContextKey]);
}
