/**
 * RULES-EVERYWHERE, on screen: the server drops every trade idea that breaks one of your hard rules
 * before it answers (server/services/campaign/never-give.js#ruleGate) and says how many it dropped
 * (`dropped_by_rule`). This line shows that count, with why, so an empty or short list is never
 * mistaken for "there was nothing". It never shows the dropped ideas themselves.
 */
export default function RulesHidden({ n, className = '' }: { n: number | null | undefined; className?: string }) {
  if (!n || n <= 0) return null;
  return (
    <details className={`ds-note ${className}`} data-testid="rules-hidden">
      <summary className="cursor-pointer">
        <span className="font-semibold">{n} idea{n === 1 ? '' : 's'} hidden by your rules</span> · why
      </summary>
      <p className="mt-1">
        Each one would have given away a player you have marked untouchable, brought back a player you sold this
        season, taken on a player who is not a blue chip, or paid more trade value than you get back. They are
        dropped before this list is drawn, so they are never shown.
      </p>
    </details>
  );
}
