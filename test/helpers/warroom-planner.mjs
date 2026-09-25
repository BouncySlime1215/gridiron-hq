/**
 * The War Room planner as the app mounts it now (no full-screen shell): Today's TodayPanel and
 * Trades' TradesPlanner parts (next / goget / market), rendered to static markup from one view.
 * `wr` is loadWarRoom()'s compiled folder. Each part keeps its own data-testid
 * (today-panel / trades-planner-<part>), so a test can slice one out.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export const PLANNER_PARTS = ['next', 'goget', 'market'];

export async function plannerRenderer(wr) {
  const { default: TodayPanel } = await wr.mod('TodayPanel');
  const { default: TradesPlanner } = await wr.mod('TradesPlanner');
  const h = React.createElement;
  /** All four mounts for `view`, or only `parts` (e.g. ['next']). */
  return (view, { leagueId = view.league_id ?? view.league, parts = ['today', ...PLANNER_PARTS], onAsk = () => {} } = {}) =>
    renderToStaticMarkup(h(React.Fragment, null, ...parts.map(part => part === 'today'
      ? h(TodayPanel, { key: part, view, leagueId, onAsk })
      : h(TradesPlanner, { key: part, part, view, leagueId, onAsk }))));
}
