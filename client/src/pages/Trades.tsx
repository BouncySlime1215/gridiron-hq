import { useSearchParams } from 'react-router-dom';
import TradeBrain from './TradeBrain';
import TradeLab from './TradeLab';
import { Tabs } from '../components/ui/DesignSystem';

/**
 * Trades (docs/ui/CONSOLIDATION-MAP.md): one trade area. Until the Trades PR merges the
 * insides into one surface, it hosts the two pages that do this job today, one at a time:
 * the planner and people (the War Room, who trades with you, sendable proposals) and the
 * trade finder (Trade Lab). Trade Brain keeps reading its own ?view= tab.
 */
type Part = 'planner' | 'find';
export default function Trades() {
  const [params, setParams] = useSearchParams();
  const part: Part = params.get('view') === 'find' ? 'find' : 'planner';
  const go = (p: Part) => setParams(() => (p === 'find' ? new URLSearchParams('view=find') : new URLSearchParams()), { replace: true });
  return (
    <div>
      <div className="mb-5">
        <Tabs label="Trades" value={part} onChange={go}
          tabs={[{ id: 'planner', label: 'Planner & people' }, { id: 'find', label: 'Trade finder' }]} />
      </div>
      {part === 'find' ? <TradeLab /> : <TradeBrain />}
    </div>
  );
}
