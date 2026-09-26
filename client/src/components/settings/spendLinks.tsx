import type { MouseEvent, ReactNode } from 'react';

/**
 * SPEND-UI cross-links (spec section 6) into Settings -> AI & developer: the brief's spend line,
 * a spend anomaly on Today > Watching, and a budget-reached message (to that budget's row).
 * No router import, so the War Room and Coach files can use it: the click pushes the URL and
 * tells the app's router (react-router listens for popstate), a middle-click still opens a tab.
 */
export const AI_SETTINGS = '/settings?view=dev';
export const budgetHref = (key: string) => `${AI_SETTINGS}&budget=${encodeURIComponent(key)}`;

export function goTo(href: string) {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function AppLink({ href, children, className, testid }: { href: string; children: ReactNode; className?: string; testid?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goTo(href);
  };
  return <a href={href} className={className ?? 'ds-link'} onClick={onClick} data-testid={testid}>{children}</a>;
}

/** "Change the budget": after a budget-reached message, to its row in Daily budgets. */
export function BudgetLink({ budgetKey, children = 'Change the budget' }: { budgetKey: string; children?: ReactNode }) {
  return <AppLink href={budgetHref(budgetKey)} testid="budget-link">{children}</AppLink>;
}
