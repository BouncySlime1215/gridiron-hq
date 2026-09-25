/**
 * WR-COACH public surface for the War Room dashboard (client/src/components/warroom/*).
 *
 *   import { useWarRoomCoach, CoachDock, PlugInCard } from './coach';
 *   const coach = useWarRoomCoach({ leagueId, leagues, plans, onLeagueChange });
 *
 * Panels read `coach.ui` and never compute an engine value.
 */
export { useWarRoomCoach, type WarRoomCoach, type CoachMessage } from './useWarRoomCoach';
export { default as CoachDock } from './CoachDock';
export { default as PlugInCard } from './PlugInCard';
export { default as CoachDrawer, FIXED_QUESTIONS } from './CoachDrawer';
export {
  validateAction, dispatch, confirm, cancel, undo, coachFooter, previewFor, readField, tradeoffKey,
  ACTION_TYPES, PLAN_CHANGING, PANELS, PLUG_IN_FIELDS,
  type CoachAction, type CoachUi, type CoachSession, type Panel, type Pending, type Outcome
} from './warroomCoach';
