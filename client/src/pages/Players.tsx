import { useSearchParams } from 'react-router-dom';
import Projections from './Projections';
import Rankings from './Rankings';
import News from './News';
import Teams from './Teams';
import { Tabs } from '../components/ui/DesignSystem';

/**
 * Players (docs/ui/CONSOLIDATION-MAP.md): the market board, your rankings and tiers, news
 * and NFL teams, one at a time. The board and rankings had no route before this; the draft
 * room and player card still read the ranking sets they edit. Player pages are
 * /players/:id and team pages /players/teams/:abbr.
 */
const VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'rankings', label: 'Rankings' },
  { id: 'news', label: 'News' },
  { id: 'teams', label: 'NFL teams' },
] as const;
type View = typeof VIEWS[number]['id'];
const isView = (v: string | null): v is View => VIEWS.some(x => x.id === v);

export default function Players({ initial }: { initial?: View } = {}) {
  const [params, setParams] = useSearchParams();
  const q = params.get('view');
  const view: View = isView(q) ? q : initial ?? 'board';
  return (
    <div>
      <div className="mb-5">
        <Tabs label="Players" value={view} onChange={v => setParams(() => new URLSearchParams(`view=${v}`), { replace: true })}
          tabs={VIEWS.map(v => ({ id: v.id, label: v.label }))} />
      </div>
      {view === 'board' && <Projections />}
      {view === 'rankings' && <Rankings />}
      {view === 'news' && <News />}
      {view === 'teams' && <Teams />}
    </div>
  );
}
