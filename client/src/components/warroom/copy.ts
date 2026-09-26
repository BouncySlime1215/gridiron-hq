/**
 * WARROOM-LABEL-FIX: shared War Room card copy that reads a league's objective instead of
 * hard-coding "title", and that runs through the one pronoun guard, server/services/people/
 * neutral.js (pure, no deps — the client imports it directly rather than keeping a second copy),
 * so a league-mate is always "they", never "he" (bug: league 4, goal=playoffs, showed "Title odds
 * if he says yes" while the number underneath was the playoff delta).
 */
import { neutral } from '../../../../server/services/people/neutral.js';

/** "Title odds" or "Playoff odds", from the plan's own objective (view.js#WARROOM-LABEL-FIX
 * `destination.goal.metric_label`) — the same `metric` that scores the card's number. */
export function metricLabelOf(goal: { metric_label?: string; metric?: string } | null | undefined): string {
  if (goal?.metric_label) return goal.metric_label;
  return goal?.metric === 'playoff' ? 'Playoff odds' : 'Title odds';
}

/** The hero/tile label: "Title odds if they say yes" or "Playoff odds if they say yes". */
export function oddsIfTheySayYes(goal: { metric_label?: string; metric?: string } | null | undefined): string {
  const base = metricLabelOf(goal);
  return neutral(`${base} if he says yes`) ?? `${base} if they say yes`;
}

/** "Chance they say yes" (ChanceStat's default label, NextMoveDeck/Negotiate tiles). */
export const CHANCE_THEY_SAY_YES = neutral('Chance he says yes') ?? 'Chance they say yes';
