import type { Partner, WarRoomView } from './types';
import { isOk } from './format';

/**
 * The weekly offer budget in the People header (it went with the retired People Board rail): each
 * league-mate Nick has sent more offers this week than his own per-manager limit allows. Reads the
 * plan's counts (partners[].offers_logged) and his limit (destination.tolerances
 * max_offers_per_manager_week) as served, and only compares them; nothing is summed or estimated.
 * Nothing shows when the plan carries no counts or no limit, or no one is over.
 */
export function offerBudgetOver(view: WarRoomView | null | undefined): { team: string; used: number; limit: number }[] {
  if (!view || !isOk(view.partners) || !isOk(view.destination)) return [];
  const tol = view.destination.value.tolerances;
  const limit = isOk(tol) ? tol.value.max_offers_per_manager_week : undefined;
  if (!Number.isInteger(limit)) return [];
  return (view.partners.value as Partner[])
    .filter(p => Number.isInteger(p.offers_logged) && (p.offers_logged as number) > (limit as number))
    .map(p => ({ team: String(p.team), used: p.offers_logged as number, limit: limit as number }));
}

export const offerBudgetText = (name: string, used: number, limit: number) =>
  `${used} offers to ${name} this week, over your ${limit}-a-week limit`;
